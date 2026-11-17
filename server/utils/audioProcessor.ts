import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ProbedAudioInfo {
  durationSec: number;
  sampleRate: number;
  channels: number;
  codec: string;
  sizeBytes: number;
}

export async function probeAudio(filePath: string): Promise<ProbedAudioInfo> {
  const stats = await fs.stat(filePath);
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=codec_name,sample_rate,channels,duration:format=duration',
    '-of',
    'json',
    filePath,
  ]);

  const parsed = JSON.parse(stdout) as {
    streams?: Array<{
      codec_name?: string;
      sample_rate?: string;
      channels?: number;
      duration?: string;
    }>;
    format?: {
      duration?: string;
    };
  };

  const stream = parsed.streams?.[0];
  if (!stream) {
    throw new Error('Uploaded file does not contain a valid audio stream.');
  }

  const rawDuration = stream.duration ?? parsed.format?.duration ?? '0';
  const durationSec = Number.parseFloat(rawDuration);
  if (!Number.isFinite(durationSec) || durationSec <= 0.1) {
    throw new Error('Could not determine a valid audio duration (minimum 0.2 seconds).');
  }

  return {
    durationSec,
    sampleRate: Number.parseInt(stream.sample_rate ?? '44100', 10) || 44100,
    channels: stream.channels ?? 1,
    codec: stream.codec_name ?? 'unknown',
    sizeBytes: stats.size,
  };
}

/**
 * Extracts real amplitude peaks from decoded PCM samples using ffmpeg.
 * Returns normalized values in [0.04, 1.0].
 */
export async function extractWaveformPeaks(filePath: string, bucketCount = 96): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        filePath,
        '-ac',
        '1',
        '-ar',
        '8000',
        '-f',
        's16le',
        'pipe:1',
      ],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
    );

    const pcmBuffer = stdout as unknown as Buffer;
    const totalSamples = Math.floor(pcmBuffer.length / 2);
    if (totalSamples < bucketCount) {
      return Array.from({ length: bucketCount }, () => 0.15);
    }

    const samplesPerBucket = Math.floor(totalSamples / bucketCount);
    const peaks: number[] = [];
    let globalMax = 1;

    for (let b = 0; b < bucketCount; b++) {
      const startSample = b * samplesPerBucket;
      const endSample = b === bucketCount - 1 ? totalSamples : startSample + samplesPerBucket;
      let peak = 0;
      const stride = Math.max(1, Math.floor((endSample - startSample) / 120));
      for (let i = startSample; i < endSample; i += stride) {
        const sample = Math.abs(pcmBuffer.readInt16LE(i * 2));
        if (sample > peak) peak = sample;
      }
      if (peak > globalMax) globalMax = peak;
      peaks.push(peak);
    }

    return peaks.map((p) => {
      const normalized = p / globalMax;
      return Number(Math.max(0.04, Math.min(1, normalized)).toFixed(3));
    });
  } catch {
    return Array.from({ length: bucketCount }, () => 0.12);
  }
}

export async function convertToMp3(inputPath: string, outputPath: string): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    inputPath,
    '-vn',
    '-acodec',
    'libmp3lame',
    '-b:a',
    '192k',
    '-ar',
    '44100',
    outputPath,
  ]);
}

export async function convertToWav(inputPath: string, outputPath: string): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    inputPath,
    '-vn',
    '-acodec',
    'pcm_s16le',
    '-ar',
    '44100',
    outputPath,
  ]);
}

/**
 * Extracts a clean speech reference sample (WAV) from the uploaded audio for voice conditioning/cloning.
 */
export async function prepareVoiceSampleWav(inputPath: string, outputPath: string, maxSeconds = 90): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    inputPath,
    '-t',
    String(maxSeconds),
    '-vn',
    '-ac',
    '1',
    '-ar',
    '44100',
    '-acodec',
    'pcm_s16le',
    outputPath,
  ]);
}

export interface TimedAudioSegmentInput {
  filePath: string;
  startSec: number;
  targetDurationSec: number;
}

/**
 * Aligns individual dubbed segment clips gently to match original speaking windows
 * (clamping tempo adjustment to [0.85, 1.18] to avoid robotic distortion) and mixes
 * them onto a clean stereo/mono timeline matching the original speaker's pauses & pacing.
 */
export async function assembleTimedSegments(
  segments: TimedAudioSegmentInput[],
  totalOriginalDurationSec: number,
  outputWavPath: string,
  tempDir: string,
  preserveRhythmAndPacing: boolean,
): Promise<void> {
  if (segments.length === 0) {
    throw new Error('No synthesized audio segments to assemble.');
  }

  await fs.mkdir(path.dirname(outputWavPath), { recursive: true });
  await fs.mkdir(tempDir, { recursive: true });

  const preparedSegments: Array<{ path: string; startMs: number; actualDurationSec: number }> = [];
  let cursorEndSec = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const probed = await probeAudio(seg.filePath);
    let processedPath = seg.filePath;
    let finalDuration = probed.durationSec;

    if (preserveRhythmAndPacing && seg.targetDurationSec > 0.4) {
      const ratio = probed.durationSec / seg.targetDurationSec;
      // Only adjust tempo within gentle natural limits (0.85x - 1.18x)
      if (ratio > 1.04 || ratio < 0.92) {
        const clampedTempo = Math.max(0.85, Math.min(1.18, ratio));
        const adjustedPath = path.join(tempDir, `seg_adj_${i}.wav`);
        await execFileAsync('ffmpeg', [
          '-y',
          '-v',
          'error',
          '-i',
          seg.filePath,
          '-filter:a',
          `atempo=${clampedTempo.toFixed(4)}`,
          '-ar',
          '44100',
          '-ac',
          '1',
          '-acodec',
          'pcm_s16le',
          adjustedPath,
        ]);
        processedPath = adjustedPath;
        const adjProbe = await probeAudio(adjustedPath);
        finalDuration = adjProbe.durationSec;
      }
    }

    // Prevent harsh overlap if a translated phrase ran slightly longer than its slot
    const effectiveStartSec = Math.max(seg.startSec, cursorEndSec > 0 ? cursorEndSec + 0.04 : 0);
    cursorEndSec = effectiveStartSec + finalDuration;

    preparedSegments.push({
      path: processedPath,
      startMs: Math.round(effectiveStartSec * 1000),
      actualDurationSec: finalDuration,
    });
  }

  const finalTimelineDuration = Math.max(totalOriginalDurationSec, cursorEndSec + 0.15);

  if (preparedSegments.length === 1 && preparedSegments[0].startMs === 0) {
    await execFileAsync('ffmpeg', [
      '-y',
      '-v',
      'error',
      '-i',
      preparedSegments[0].path,
      '-ar',
      '44100',
      '-ac',
      '1',
      '-acodec',
      'pcm_s16le',
      outputWavPath,
    ]);
    return;
  }

  // Build ffmpeg filter_complex placing each clip at its exact millisecond offset
  const inputs: string[] = [];
  const filterParts: string[] = [];
  const mixInputs: string[] = [];

  for (let i = 0; i < preparedSegments.length; i++) {
    inputs.push('-i', preparedSegments[i].path);
    const delayMs = preparedSegments[i].startMs;
    filterParts.push(
      `[${i}:a]aformat=sample_rates=44100:channel_layouts=mono,adelay=${delayMs}|${delayMs}[a${i}]`,
    );
    mixInputs.push(`[a${i}]`);
  }

  const filterComplex = `${filterParts.join(';')};${mixInputs.join('')}amix=inputs=${preparedSegments.length}:duration=longest:normalize=0,apad=whole_dur=${finalTimelineDuration.toFixed(3)}[out]`;

  await execFileAsync('ffmpeg', [
    '-y',
    '-v',
    'error',
    ...inputs,
    '-filter_complex',
    filterComplex,
    '-map',
    '[out]',
    '-ar',
    '44100',
    '-ac',
    '1',
    '-acodec',
    'pcm_s16le',
    outputWavPath,
  ]);
}
