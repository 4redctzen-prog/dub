import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { translateWithExternalLlm } from '../adapters/llmAdapter.ts';
import { getConfig } from '../config.ts';
import { translateWithGeminiFallback } from '../providers/geminiProvider.ts';
import { getVoiceProvider } from '../providers/providerFactory.ts';
import type {
  AudioMetadata,
  DubbingJob,
  DubbingSettings,
  LanguageTask,
  SupportedLanguage,
} from '../types.ts';
import {
  convertToMp3,
  convertToWav,
  extractWaveformPeaks,
  probeAudio,
} from '../utils/audioProcessor.ts';
import {
  buildSrtFromWords,
  normalizeAndClampSrt,
  validateSrt,
} from '../utils/srtGenerator.ts';

const jobs = new Map<string, DubbingJob>();
const activePipelines = new Set<string>();

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-() ]+/g, '_');
  return base || 'recording';
}

function getJobDir(jobId: string): string {
  return path.join(getConfig().jobsDir, jobId);
}

async function persistJob(job: DubbingJob): Promise<void> {
  job.updatedAt = Date.now();
  const dir = getJobDir(job.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify(job, null, 2), 'utf8');
}

export async function initializeStorage(): Promise<void> {
  const cfg = getConfig();
  await fs.mkdir(cfg.tempDir, { recursive: true });
  await fs.mkdir(cfg.jobsDir, { recursive: true });

  // Restore persisted jobs on startup
  try {
    const entries = await fs.readdir(cfg.jobsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = path.join(cfg.jobsDir, entry.name, 'job.json');
      try {
        const raw = await fs.readFile(metaPath, 'utf8');
        const parsed = JSON.parse(raw) as DubbingJob;
        if (parsed?.id) {
          // If server restarted mid-job, mark unfinished job/languages cleanly as failed so user can retry
          if (
            parsed.stage !== 'completed' &&
            parsed.stage !== 'failed'
          ) {
            parsed.stage = 'failed';
            parsed.stageLabel = 'Interrupted by server restart';
            parsed.error = 'Server restarted while processing. Click Retry to resume.';
            for (const lang of parsed.languages) {
              if (lang.status !== 'completed' && lang.status !== 'failed') {
                lang.status = 'failed';
                lang.stageLabel = 'Interrupted';
                lang.error = 'Interrupted by server restart.';
              }
            }
          }
          jobs.set(parsed.id, parsed);
        }
      } catch {
        // Ignore corrupted directory
      }
    }
  } catch {
    // Ignore initial read error
  }

  // Automatic cleanup of temporary files and expired jobs
  const runCleanup = async () => {
    const now = Date.now();
    try {
      const tempFiles = await fs.readdir(cfg.tempDir, { withFileTypes: true });
      for (const f of tempFiles) {
        const full = path.join(cfg.tempDir, f.name);
        const stat = await fs.stat(full).catch(() => null);
        if (stat && now - stat.mtimeMs > cfg.tempTtlMs) {
          await fs.rm(full, { recursive: true, force: true }).catch(() => {});
        }
      }
    } catch {
      // Ignore temp cleanup errors
    }

    const jobRetentionMs = Math.max(cfg.tempTtlMs * 24, 24 * 60 * 60 * 1000);
    for (const [id, job] of jobs.entries()) {
      if (!activePipelines.has(id) && now - job.updatedAt > jobRetentionMs) {
        await deleteJob(id).catch(() => {});
      }
    }
  };

  setInterval(runCleanup, 15 * 60 * 1000).unref();
}

export function getJob(jobId: string): DubbingJob | undefined {
  return jobs.get(jobId);
}

/**
 * Strips filesystem paths before returning job state to the client.
 */
export function serializeJobForClient(job: DubbingJob) {
  return {
    id: job.id,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    stage: job.stage,
    stageLabel: job.stageLabel,
    voiceCloneAuthorized: job.voiceCloneAuthorized,
    sourceLanguageInput: job.sourceLanguageInput,
    detectedSourceLanguage: job.detectedSourceLanguage,
    settings: job.settings,
    originalAudio: job.originalAudio,
    originalAudioUrl: `/api/jobs/${job.id}/audio/original`,
    sourceTranscription: job.sourceTranscription
      ? {
          languageCode: job.sourceTranscription.languageCode,
          text: job.sourceTranscription.text,
          segmentCount: job.sourceTranscription.segments.length,
        }
      : undefined,
    providerLimitationNotice: job.providerLimitationNotice,
    error: job.error,
    languages: job.languages.map((l) => ({
      languageCode: l.languageCode,
      languageName: l.languageName,
      nativeName: l.nativeName,
      status: l.status,
      stageLabel: l.stageLabel,
      providerProgress: l.providerProgress ?? null,
      dubbingMethodUsed: l.dubbingMethodUsed,
      providerLimitationNotice: l.providerLimitationNotice,
      translatedScript: l.translation?.fullTranslatedText,
      llmModel: l.translation?.llmModel,
      durationSec: l.durationSec,
      waveformPeaks: l.waveformPeaks,
      audioPreviewUrl: l.mp3Path ? `/api/jobs/${job.id}/languages/${l.languageCode}/audio` : undefined,
      mp3DownloadUrl: l.mp3Path ? `/api/jobs/${job.id}/languages/${l.languageCode}/download/mp3` : undefined,
      wavDownloadUrl: l.wavPath ? `/api/jobs/${job.id}/languages/${l.languageCode}/download/wav` : undefined,
      srtDownloadUrl: l.subtitle.srtPath ? `/api/jobs/${job.id}/languages/${l.languageCode}/download/srt` : undefined,
      mp3Filename: l.mp3Filename,
      wavFilename: l.wavFilename,
      subtitle: {
        status: l.subtitle.status,
        srtFilename: l.subtitle.srtFilename,
        srtPreview: l.subtitle.srtPreview,
        cueCount: l.subtitle.cueCount,
        alignmentMethod: l.subtitle.alignmentMethod,
        error: l.subtitle.error,
      },
      error: l.error,
      startedAt: l.startedAt,
      completedAt: l.completedAt,
    })),
  };
}

export async function inspectUploadedAudio(tempFilePath: string, originalFilename: string, mimeType: string): Promise<AudioMetadata> {
  const cfg = getConfig();
  const probed = await probeAudio(tempFilePath);
  if (probed.durationSec > cfg.maxDurationSec) {
    throw new Error(
      `Audio duration (${Math.round(probed.durationSec)}s) exceeds the maximum allowed limit of ${cfg.maxDurationSec}s.`,
    );
  }
  const waveformPeaks = await extractWaveformPeaks(tempFilePath, 96);
  return {
    originalFilename: sanitizeFilename(originalFilename),
    mimeType,
    sizeBytes: probed.sizeBytes,
    durationSec: probed.durationSec,
    sampleRate: probed.sampleRate,
    channels: probed.channels,
    codec: probed.codec,
    waveformPeaks,
  };
}

export async function createDubbingJob(params: {
  tempFilePath: string;
  originalFilename: string;
  mimeType: string;
  sourceLanguage: string;
  targetLanguages: string[];
  settings: DubbingSettings;
  voiceCloneAuthorized: boolean;
}): Promise<DubbingJob> {
  if (!params.voiceCloneAuthorized) {
    throw new Error('Speaker authorization confirmation is required before cloning and dubbing the uploaded voice.');
  }

  const provider = getVoiceProvider(params.settings.workflowMode);
  const supportedMap = new Map<string, SupportedLanguage>(
    provider.getSupportedLanguages().map((l) => [l.code, l]),
  );

  const uniqueTargetCodes = Array.from(new Set(params.targetLanguages.map((c) => c.trim()))).filter(Boolean);
  if (uniqueTargetCodes.length === 0) {
    throw new Error('Select at least one supported target language.');
  }

  const languageTasks: LanguageTask[] = uniqueTargetCodes.map((code) => {
    const info = supportedMap.get(code);
    if (!info) {
      throw new Error(`Language "${code}" is not supported by the configured voice provider (${provider.name}).`);
    }
    return {
      languageCode: info.code,
      languageName: info.name,
      nativeName: info.nativeName,
      status: 'pending',
      stageLabel: 'Queued',
      subtitle: { status: 'pending' },
    };
  });

  const audioMeta = await inspectUploadedAudio(
    params.tempFilePath,
    params.originalFilename,
    params.mimeType,
  );

  const jobId = crypto.randomUUID();
  const jobDir = getJobDir(jobId);
  await fs.mkdir(jobDir, { recursive: true });

  const ext = path.extname(audioMeta.originalFilename) || '.audio';
  const storedOriginalPath = path.join(jobDir, `original${ext}`);
  await fs.rename(params.tempFilePath, storedOriginalPath);

  const job: DubbingJob = {
    id: jobId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stage: 'processing_original',
    stageLabel: 'Processing original recording',
    voiceCloneAuthorized: true,
    sourceLanguageInput: params.sourceLanguage || 'auto',
    settings: params.settings,
    originalAudio: audioMeta,
    originalAudioPath: storedOriginalPath,
    languages: languageTasks,
  };

  jobs.set(jobId, job);
  await persistJob(job);

  // Start background orchestration
  void runJobPipeline(jobId);

  return job;
}

async function generateAndValidateSubtitles(
  job: DubbingJob,
  langTask: LanguageTask,
  providerSrtTranscript?: string,
): Promise<void> {
  if (!langTask.mp3Path) {
    throw new Error('Dubbed audio file is missing for subtitle generation.');
  }
  const provider = getVoiceProvider(job.settings.workflowMode);
  langTask.subtitle = { status: 'generating' };
  await persistJob(job);

  try {
    const dubbedProbe = await probeAudio(langTask.mp3Path);
    const dubbedDurationSec = dubbedProbe.durationSec;

    const alignment = await provider.generateTimestampsForSubtitles({
      dubbedAudioPath: langTask.mp3Path,
      targetLangCode: langTask.languageCode,
      expectedText: langTask.translation?.fullTranslatedText,
      providerSrtTranscript,
    });

    let srtContent = '';
    let cueCount = 0;

    if (alignment.words && alignment.words.length > 0) {
      const built = buildSrtFromWords(alignment.words, dubbedDurationSec, langTask.languageCode);
      srtContent = built.srtContent;
      cueCount = built.cues.length;
    } else if (alignment.providerSrt) {
      const normalized = normalizeAndClampSrt(alignment.providerSrt, dubbedDurationSec);
      srtContent = normalized.srtContent;
      cueCount = normalized.cueCount;
    } else {
      throw new Error('Could not obtain timestamped alignment for dubbed audio.');
    }

    const validation = validateSrt(srtContent, dubbedDurationSec);
    if (!validation.valid) {
      throw new Error(`SRT validation failed: ${validation.errors.slice(0, 3).join(' ')}`);
    }

    const supported = provider.getSupportedLanguages().find((l) => l.code === langTask.languageCode);
    const slug = supported?.filenameSlug ?? langTask.languageCode;
    const srtFilename = `${slug}_subtitles.srt`;
    const srtPath = path.join(getJobDir(job.id), 'outputs', langTask.languageCode, srtFilename);
    await fs.mkdir(path.dirname(srtPath), { recursive: true });
    await fs.writeFile(srtPath, srtContent, 'utf8');

    langTask.subtitle = {
      status: 'completed',
      srtPath,
      srtFilename,
      srtPreview: srtContent,
      cueCount,
      alignmentMethod: alignment.alignmentMethod,
    };
  } catch (err) {
    langTask.subtitle = {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  await persistJob(job);
}

async function processSingleLanguage(job: DubbingJob, langTask: LanguageTask): Promise<void> {
  const provider = getVoiceProvider(job.settings.workflowMode);
  const supported = provider.getSupportedLanguages().find((l) => l.code === langTask.languageCode);
  const slug = supported?.filenameSlug ?? langTask.languageCode;
  const outputDir = path.join(getJobDir(job.id), 'outputs', langTask.languageCode);
  const workDir = path.join(getConfig().tempDir, `${job.id}_${langTask.languageCode}_${Date.now()}`);

  langTask.startedAt = Date.now();
  langTask.error = undefined;

  try {
    // Step 1: External LLM Translation (unless native_dubbing mode was explicitly requested)
    if (job.settings.workflowMode !== 'native_dubbing') {
      if (!job.sourceTranscription) {
        throw new Error('Original source transcription is missing.');
      }

      const cfg = getConfig();
      const hasExternalLlm = Boolean(cfg.llmApiUrl && cfg.llmApiKey && cfg.llmModel);
      const isGeminiMode =
        job.settings.workflowMode === 'gemini_only' ||
        cfg.voiceProvider === 'gemini' ||
        cfg.voiceProvider === 'gemini-only' ||
        cfg.voiceProvider === 'gemini_only';

      job.stage = 'translating';
      job.stageLabel = `Translating to ${langTask.languageName}`;
      langTask.status = 'translating';
      langTask.stageLabel = hasExternalLlm
        ? 'Translating via configured LLM'
        : 'Translating via Gemini';
      await persistJob(job);

      const sourceLangInfo = provider
        .getSupportedLanguages()
        .find((l) => l.code === job.sourceTranscription?.languageCode);
      const sourceLabel = sourceLangInfo
        ? `${sourceLangInfo.name} (${sourceLangInfo.code})`
        : job.sourceTranscription.languageCode;

      if (hasExternalLlm || !isGeminiMode) {
        langTask.translation = await translateWithExternalLlm({
          sourceTranscription: job.sourceTranscription,
          sourceLanguageLabel: sourceLabel,
          targetLanguageCode: langTask.languageCode,
          targetLanguageName: langTask.languageName,
          settings: job.settings,
        });
      } else {
        langTask.translation = await translateWithGeminiFallback({
          sourceTranscription: job.sourceTranscription,
          sourceLanguageLabel: sourceLabel,
          targetLanguageCode: langTask.languageCode,
          targetLanguageName: langTask.languageName,
          settings: job.settings,
        });
      }
      await persistJob(job);
    }

    // Step 2: Generate cloned voice & dubbed speech
    job.stage = 'generating_voice';
    job.stageLabel = `Generating cloned voice (${langTask.languageName})`;
    langTask.status = 'generating_voice';
    langTask.stageLabel = 'Generating cloned voice';
    await persistJob(job);

    const synthesis = await provider.dubWithExternalTranslation({
      originalAudioPath: job.originalAudioPath,
      sourceLang: job.detectedSourceLanguage ?? job.sourceLanguageInput,
      sourceTranscriptText: job.sourceTranscription?.text,
      targetLang: langTask.languageCode,
      translation: langTask.translation ?? {
        targetLanguageCode: langTask.languageCode,
        targetLanguageName: langTask.languageName,
        fullTranslatedText: '',
        segments: [],
        llmModel: 'provider-internal',
      },
      settings: job.settings,
      originalDurationSec: job.originalAudio.durationSec,
      workDir,
      onProgress: (label, progressPct) => {
        langTask.stageLabel = label;
        if (progressPct !== undefined) langTask.providerProgress = progressPct;
        void persistJob(job);
      },
    });

    langTask.dubbingMethodUsed = synthesis.methodUsed;
    if (synthesis.providerLimitationNotice) {
      langTask.providerLimitationNotice = synthesis.providerLimitationNotice;
      job.providerLimitationNotice = synthesis.providerLimitationNotice;
    }

    // Step 3: FFmpeg final audio export (MP3 + WAV + real waveform)
    job.stage = 'processing_final_audio';
    job.stageLabel = `Processing final audio (${langTask.languageName})`;
    langTask.status = 'processing_final_audio';
    langTask.stageLabel = 'Processing final MP3 & WAV';
    await persistJob(job);

    await fs.mkdir(outputDir, { recursive: true });
    const mp3Filename = `${slug}_dub.mp3`;
    const wavFilename = `${slug}_dub.wav`;
    const mp3Path = path.join(outputDir, mp3Filename);
    const wavPath = path.join(outputDir, wavFilename);

    await Promise.all([
      convertToMp3(synthesis.dubbedAudioPath, mp3Path),
      convertToWav(synthesis.dubbedAudioPath, wavPath),
    ]);

    const finalProbe = await probeAudio(mp3Path);
    const finalPeaks = await extractWaveformPeaks(mp3Path, 96);

    langTask.mp3Path = mp3Path;
    langTask.wavPath = wavPath;
    langTask.mp3Filename = mp3Filename;
    langTask.wavFilename = wavFilename;
    langTask.durationSec = finalProbe.durationSec;
    langTask.waveformPeaks = finalPeaks;
    langTask.status = 'generating_subtitles';
    langTask.stageLabel = 'Generating synchronized SRT';
    job.stage = 'generating_subtitles';
    job.stageLabel = `Generating synchronized SRT (${langTask.languageName})`;
    await persistJob(job);

    // Step 4: Independent SRT Subtitle Generation & Validation
    // Subtitle failure does NOT discard successful dubbed audio.
    await generateAndValidateSubtitles(job, langTask, synthesis.providerSrtTranscript);

    langTask.status = 'completed';
    langTask.stageLabel =
      langTask.subtitle.status === 'completed'
        ? 'Completed'
        : 'Audio completed (SRT failed)';
    langTask.completedAt = Date.now();
    await persistJob(job);
  } catch (err) {
    langTask.status = 'failed';
    langTask.stageLabel = 'Failed';
    langTask.error = err instanceof Error ? err.message : String(err);
    await persistJob(job);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runJobPipeline(jobId: string): Promise<void> {
  if (activePipelines.has(jobId)) return;
  const job = jobs.get(jobId);
  if (!job) return;

  activePipelines.add(jobId);
  const provider = getVoiceProvider(job.settings.workflowMode);

  try {
    job.error = undefined;

    // Transcribe original audio once if needed
    if (job.settings.workflowMode !== 'native_dubbing' && !job.sourceTranscription) {
      job.stage = 'processing_original';
      job.stageLabel = 'Processing original recording';
      await persistJob(job);

      const transcription = await provider.transcribeOriginalAudio(
        job.originalAudioPath,
        job.sourceLanguageInput,
      );
      job.sourceTranscription = transcription;
      job.detectedSourceLanguage = transcription.languageCode;
      await persistJob(job);
    }

    const pendingLanguages = job.languages.filter((l) => l.status !== 'completed');
    for (const langTask of pendingLanguages) {
      await processSingleLanguage(job, langTask);
    }

    const completedCount = job.languages.filter((l) => l.status === 'completed').length;
    if (completedCount > 0) {
      job.stage = 'completed';
      job.stageLabel =
        completedCount === job.languages.length
          ? 'Completed'
          : `Completed ${completedCount} of ${job.languages.length} languages`;
    } else {
      job.stage = 'failed';
      job.stageLabel = 'Failed';
      job.error =
        job.languages.find((l) => l.error)?.error ?? 'All target language generations failed.';
    }
    await persistJob(job);
  } catch (err) {
    job.stage = 'failed';
    job.stageLabel = 'Failed';
    job.error = err instanceof Error ? err.message : String(err);
    for (const l of job.languages) {
      if (l.status !== 'completed') {
        l.status = 'failed';
        l.stageLabel = 'Failed';
        l.error = job.error;
      }
    }
    await persistJob(job);
  } finally {
    activePipelines.delete(jobId);
  }
}

export async function retryJob(jobId: string, targetLanguageCode?: string): Promise<DubbingJob> {
  const job = jobs.get(jobId);
  if (!job) throw new Error('Job not found.');
  if (activePipelines.has(jobId)) return job;

  for (const l of job.languages) {
    if (targetLanguageCode) {
      if (l.languageCode === targetLanguageCode && l.status === 'failed') {
        l.status = 'pending';
        l.stageLabel = 'Queued for retry';
        l.error = undefined;
      }
    } else if (l.status === 'failed') {
      l.status = 'pending';
      l.stageLabel = 'Queued for retry';
      l.error = undefined;
    }
  }

  job.stage = 'processing_original';
  job.stageLabel = 'Retrying dubbing pipeline';
  job.error = undefined;
  await persistJob(job);

  void runJobPipeline(jobId);
  return job;
}

export async function retryLanguageSubtitles(jobId: string, langCode: string): Promise<DubbingJob> {
  const job = jobs.get(jobId);
  if (!job) throw new Error('Job not found.');
  const langTask = job.languages.find((l) => l.languageCode === langCode);
  if (!langTask) throw new Error(`Language "${langCode}" not found in this job.`);
  if (!langTask.mp3Path) throw new Error('Generated audio is not available for subtitle generation.');

  await generateAndValidateSubtitles(job, langTask);
  langTask.stageLabel =
    langTask.subtitle.status === 'completed' ? 'Completed' : 'Audio completed (SRT failed)';
  await persistJob(job);
  return job;
}

export async function addLanguagesToJob(jobId: string, newLangCodes: string[]): Promise<DubbingJob> {
  const job = jobs.get(jobId);
  if (!job) throw new Error('Job not found.');
  const provider = getVoiceProvider(job.settings.workflowMode);
  const supportedMap = new Map<string, SupportedLanguage>(
    provider.getSupportedLanguages().map((l) => [l.code, l]),
  );

  const existingCodes = new Set(job.languages.map((l) => l.languageCode));
  const added: LanguageTask[] = [];

  for (const rawCode of newLangCodes) {
    const code = rawCode.trim();
    if (!code || existingCodes.has(code)) continue;
    const info = supportedMap.get(code);
    if (!info) {
      throw new Error(`Language "${code}" is not supported by ${provider.name}.`);
    }
    existingCodes.add(code);
    added.push({
      languageCode: info.code,
      languageName: info.name,
      nativeName: info.nativeName,
      status: 'pending',
      stageLabel: 'Queued',
      subtitle: { status: 'pending' },
    });
  }

  if (added.length === 0) {
    throw new Error('Select at least one new target language that has not already been generated.');
  }

  job.languages.push(...added);
  job.stage = 'translating';
  job.stageLabel = `Adding ${added.map((a) => a.languageName).join(', ')}`;
  await persistJob(job);

  void runJobPipeline(jobId);
  return job;
}

export async function createZipArchiveForJob(jobId: string): Promise<{ buffer: Buffer; filename: string }> {
  const job = jobs.get(jobId);
  if (!job) throw new Error('Job not found.');

  const zip = new JSZip();
  let addedCount = 0;

  for (const lang of job.languages) {
    if (lang.status !== 'completed') continue;
    if (lang.mp3Path && lang.mp3Filename) {
      const data = await fs.readFile(lang.mp3Path).catch(() => null);
      if (data) {
        zip.file(lang.mp3Filename, data);
        addedCount++;
      }
    }
    if (lang.wavPath && lang.wavFilename) {
      const data = await fs.readFile(lang.wavPath).catch(() => null);
      if (data) {
        zip.file(lang.wavFilename, data);
        addedCount++;
      }
    }
    if (lang.subtitle.srtPath && lang.subtitle.srtFilename) {
      const data = await fs.readFile(lang.subtitle.srtPath).catch(() => null);
      if (data) {
        zip.file(lang.subtitle.srtFilename, data);
        addedCount++;
      }
    }
  }

  if (addedCount === 0) {
    throw new Error('No completed audio or subtitle files are available to archive.');
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const baseName = path.parse(job.originalAudio.originalFilename).name.replace(/[^\w\-]+/g, '_');
  return {
    buffer,
    filename: `${baseName || 'dubbing'}_multilingual_export.zip`,
  };
}

export async function deleteJob(jobId: string): Promise<void> {
  jobs.delete(jobId);
  await fs.rm(getJobDir(jobId), { recursive: true, force: true });
}
