import fs from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '../config.ts';
import type {
  DubbingSettings,
  LanguageTranslationResult,
  SourceTranscription,
  TranscriptSegment,
  WordTimestamp,
} from '../types.ts';
import {
  assembleTimedSegments,
  prepareVoiceSampleWav,
  type TimedAudioSegmentInput,
} from '../utils/audioProcessor.ts';
import type { DubbingSynthesisResult } from './voiceProvider.ts';

function buildAuthHeaders(extra?: Record<string, string>): Record<string, string> {
  const cfg = getConfig();
  const headers: Record<string, string> = { ...(extra ?? {}) };
  if (cfg.voiceCloneApiKey) {
    const headerName = cfg.voiceCloneAuthHeader || 'Authorization';
    const prefix = cfg.voiceCloneAuthPrefix;
    headers[headerName] = prefix ? `${prefix} ${cfg.voiceCloneApiKey}` : cfg.voiceCloneApiKey;
  }
  return headers;
}

async function decodeAudioResponseToFile(res: Response, outPathBase: string): Promise<string> {
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();

  if (contentType.includes('application/json')) {
    const json = (await res.json()) as Record<string, unknown>;
    const urlCandidate =
      (typeof json.audio_url === 'string' && json.audio_url) ||
      (typeof json.url === 'string' && json.url) ||
      (typeof json.output === 'string' && json.output.startsWith('http') ? json.output : '');

    if (urlCandidate) {
      const audioRes = await fetch(urlCandidate);
      if (!audioRes.ok) {
        throw new Error(`Failed to download cloned audio from external URL (${audioRes.status}).`);
      }
      const ext = urlCandidate.toLowerCase().includes('.mp3') ? '.mp3' : '.wav';
      const outPath = `${outPathBase}${ext}`;
      await fs.writeFile(outPath, Buffer.from(await audioRes.arrayBuffer()));
      return outPath;
    }

    const b64Candidate =
      (typeof json.audio_base64 === 'string' && json.audio_base64) ||
      (typeof json.audio === 'string' && json.audio) ||
      (typeof json.data === 'string' && json.data) ||
      '';

    if (b64Candidate) {
      const cleanB64 = b64Candidate.replace(/^data:audio\/[\w.+-]+;base64,/, '');
      const outPath = `${outPathBase}.wav`;
      await fs.writeFile(outPath, Buffer.from(cleanB64, 'base64'));
      return outPath;
    }

    throw new Error(
      `External Voice Cloning API returned JSON without audio_url or audio_base64 (keys: ${Object.keys(json).join(', ')}).`,
    );
  }

  // Raw binary audio stream
  const ext = contentType.includes('mpeg') || contentType.includes('mp3') ? '.mp3' : '.wav';
  const outPath = `${outPathBase}${ext}`;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 128) {
    throw new Error('External Voice Cloning API returned an empty audio response.');
  }
  await fs.writeFile(outPath, buf);
  return outPath;
}

async function synthesizeSegmentMultipart(params: {
  apiUrl: string;
  sampleBuf: Buffer;
  text: string;
  targetLang: string;
  sourceTranscriptText?: string;
  settings: DubbingSettings;
  model: string;
  outPathBase: string;
}): Promise<string> {
  const { apiUrl, sampleBuf, text, targetLang, sourceTranscriptText, settings, model, outPathBase } = params;

  const form = new FormData();
  const sampleBlob = new Blob([new Uint8Array(sampleBuf)], { type: 'audio/wav' });
  // Include standard field aliases so XTTS / OpenVoice / Chatterbox / FastAPI endpoints match cleanly
  form.append('speaker_wav', sampleBlob, 'voice_reference.wav');
  form.append('reference_audio', sampleBlob, 'voice_reference.wav');
  form.append('text', text);
  form.append('language', targetLang);
  if (model) form.append('model', model);
  if (sourceTranscriptText) form.append('reference_text', sourceTranscriptText);
  form.append('preserve_speaker_identity', String(settings.preserveSpeakerIdentity));
  form.append('preserve_narration_style', String(settings.preserveNarrationStyle));
  form.append('preserve_emotional_expression', String(settings.preserveEmotionalExpression));
  form.append('preserve_pacing', String(settings.preserveRhythmAndPacing));

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: buildAuthHeaders(),
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`External Voice Cloning API (${res.status}): ${errText.slice(0, 350)}`);
  }

  return decodeAudioResponseToFile(res, outPathBase);
}

async function synthesizeSegmentJsonBase64(params: {
  apiUrl: string;
  sampleBase64: string;
  text: string;
  targetLang: string;
  sourceTranscriptText?: string;
  settings: DubbingSettings;
  model: string;
  outPathBase: string;
}): Promise<string> {
  const { apiUrl, sampleBase64, text, targetLang, sourceTranscriptText, settings, model, outPathBase } = params;

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      model: model || undefined,
      text,
      language: targetLang,
      reference_audio_base64: sampleBase64,
      reference_text: sourceTranscriptText,
      preserve_speaker_identity: settings.preserveSpeakerIdentity,
      preserve_narration_style: settings.preserveNarrationStyle,
      preserve_emotional_expression: settings.preserveEmotionalExpression,
      preserve_pacing: settings.preserveRhythmAndPacing,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`External Voice Cloning API (${res.status}): ${errText.slice(0, 350)}`);
  }

  return decodeAudioResponseToFile(res, outPathBase);
}

async function synthesizeWithCartesia(params: {
  apiUrl: string;
  sampleBuf: Buffer;
  segments: LanguageTranslationResult['segments'];
  targetLang: string;
  model: string;
  workDir: string;
  onProgress?: (label: string) => void;
}): Promise<TimedAudioSegmentInput[]> {
  const cfg = getConfig();
  if (!cfg.voiceCloneApiKey) {
    throw new Error('VOICE_CLONE_API_KEY is required for Cartesia voice cloning.');
  }

  const baseOrigin = (() => {
    try {
      return new URL(params.apiUrl).origin;
    } catch {
      return 'https://api.cartesia.ai';
    }
  })();

  const cartesiaHeaders = {
    'X-API-Key': cfg.voiceCloneApiKey,
    'Cartesia-Version': '2025-04-16',
  };

  // 1. Clone voice from original speaker sample
  params.onProgress?.('Cloning speaker voice via Cartesia API');
  const cloneForm = new FormData();
  cloneForm.append('clip', new Blob([new Uint8Array(params.sampleBuf)], { type: 'audio/wav' }), 'voice_reference.wav');
  cloneForm.append('name', `dub_clone_${Date.now()}`);
  cloneForm.append('language', params.targetLang);
  cloneForm.append('mode', 'similarity');

  const cloneRes = await fetch(`${baseOrigin}/voices/clone`, {
    method: 'POST',
    headers: cartesiaHeaders,
    body: cloneForm,
  });

  if (!cloneRes.ok) {
    const errText = await cloneRes.text().catch(() => '');
    throw new Error(`Cartesia voice clone failed (${cloneRes.status}): ${errText.slice(0, 350)}`);
  }

  const clonedVoice = (await cloneRes.json()) as { id?: string };
  if (!clonedVoice.id) {
    throw new Error('Cartesia did not return a cloned voice id.');
  }

  const ttsUrl = params.apiUrl.includes('/tts') ? params.apiUrl : `${baseOrigin}/tts/bytes`;
  const results: TimedAudioSegmentInput[] = [];

  try {
    for (let i = 0; i < params.segments.length; i++) {
      const seg = params.segments[i];
      params.onProgress?.(`Synthesizing segment ${i + 1} of ${params.segments.length} (Cartesia)`);

      const ttsRes = await fetch(ttsUrl, {
        method: 'POST',
        headers: {
          ...cartesiaHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model_id: params.model || 'sonic-2',
          transcript: seg.translatedText,
          voice: { mode: 'id', id: clonedVoice.id },
          language: params.targetLang,
          output_format: {
            container: 'wav',
            encoding: 'pcm_s16le',
            sample_rate: 44100,
          },
        }),
      });

      if (!ttsRes.ok) {
        const errText = await ttsRes.text().catch(() => '');
        throw new Error(`Cartesia TTS failed (${ttsRes.status}): ${errText.slice(0, 350)}`);
      }

      const segPath = path.join(params.workDir, `ext_seg_${i}.wav`);
      await fs.writeFile(segPath, Buffer.from(await ttsRes.arrayBuffer()));
      results.push({
        filePath: segPath,
        startSec: seg.start,
        targetDurationSec: Math.max(0.4, seg.end - seg.start),
      });
    }
    return results;
  } finally {
    await fetch(`${baseOrigin}/voices/${clonedVoice.id}`, {
      method: 'DELETE',
      headers: cartesiaHeaders,
    }).catch(() => {});
  }
}

async function synthesizeWithFishAudio(params: {
  apiUrl: string;
  sampleBuf: Buffer;
  sampleBase64: string;
  segments: LanguageTranslationResult['segments'];
  sourceTranscriptText?: string;
  model: string;
  workDir: string;
  onProgress?: (label: string) => void;
}): Promise<TimedAudioSegmentInput[]> {
  const cfg = getConfig();
  if (!cfg.voiceCloneApiKey) {
    throw new Error('VOICE_CLONE_API_KEY is required for Fish Audio voice cloning.');
  }

  const baseOrigin = (() => {
    try {
      return new URL(params.apiUrl).origin;
    } catch {
      return 'https://api.fish.audio';
    }
  })();

  const ttsUrl = params.apiUrl.includes('/tts') ? params.apiUrl : `${baseOrigin}/v1/tts`;
  const fishModel = params.model || 's2.1-pro-free';
  const fishAuthHeaders = (extra?: Record<string, string>): Record<string, string> =>
    params.apiUrl.toLowerCase().includes('fish.audio')
      ? { Authorization: `Bearer ${cfg.voiceCloneApiKey}`, ...(extra ?? {}) }
      : buildAuthHeaders(extra);
  const results: TimedAudioSegmentInput[] = [];

  // 1. Create a temporary instant voice clone via POST /model so TTS can use JSON + reference_id
  params.onProgress?.(`Cloning speaker voice via Fish Audio (${fishModel})`);
  const cloneForm = new FormData();
  cloneForm.append(
    'voices',
    new Blob([new Uint8Array(params.sampleBuf)], { type: 'audio/wav' }),
    'voice_reference.wav',
  );
  cloneForm.append('type', 'tts');
  cloneForm.append('title', `dub_clone_${Date.now()}`);
  cloneForm.append('description', 'Temporary voice clone for multilingual dubbing');
  cloneForm.append('visibility', 'private');
  cloneForm.append('train_mode', 'fast');
  if (params.sourceTranscriptText?.trim()) {
    cloneForm.append('texts', params.sourceTranscriptText.trim());
  }

  const cloneRes = await fetch(`${baseOrigin}/model`, {
    method: 'POST',
    headers: fishAuthHeaders(),
    body: cloneForm,
  });

  // Fallback for custom Fish Speech proxies that only expose /v1/tts with inline references
  if (cloneRes.status === 404 || cloneRes.status === 405) {
    for (let i = 0; i < params.segments.length; i++) {
      const seg = params.segments[i];
      params.onProgress?.(
        `Synthesizing segment ${i + 1} of ${params.segments.length} (Fish Audio ${fishModel})`,
      );
      const ttsRes = await fetch(ttsUrl, {
        method: 'POST',
        headers: fishAuthHeaders({
          'Content-Type': 'application/json',
          model: fishModel,
        }),
        body: JSON.stringify({
          text: seg.translatedText,
          format: 'wav',
          references: [
            {
              audio: params.sampleBase64,
              text: params.sourceTranscriptText || '',
            },
          ],
        }),
      });

      if (!ttsRes.ok) {
        const errText = await ttsRes.text().catch(() => '');
        throw new Error(`Fish Audio TTS failed (${ttsRes.status}): ${errText.slice(0, 350)}`);
      }

      const segFilePath = await decodeAudioResponseToFile(
        ttsRes,
        path.join(params.workDir, `ext_seg_${i}`),
      );
      results.push({
        filePath: segFilePath,
        startSec: seg.start,
        targetDurationSec: Math.max(0.4, seg.end - seg.start),
      });
    }
    return results;
  }

  if (!cloneRes.ok) {
    const errText = await cloneRes.text().catch(() => '');
    throw new Error(`Fish Audio voice clone failed (${cloneRes.status}): ${errText.slice(0, 350)}`);
  }

  const clonedModel = (await cloneRes.json()) as { _id?: string; id?: string };
  const modelId = clonedModel._id || clonedModel.id;
  if (!modelId) {
    throw new Error('Fish Audio did not return a cloned voice model id.');
  }

  try {
    for (let i = 0; i < params.segments.length; i++) {
      const seg = params.segments[i];
      params.onProgress?.(
        `Synthesizing segment ${i + 1} of ${params.segments.length} (Fish Audio ${fishModel})`,
      );

      const ttsRes = await fetch(ttsUrl, {
        method: 'POST',
        headers: fishAuthHeaders({
          'Content-Type': 'application/json',
          model: fishModel,
        }),
        body: JSON.stringify({
          text: seg.translatedText,
          reference_id: modelId,
          format: 'wav',
        }),
      });

      if (!ttsRes.ok) {
        const errText = await ttsRes.text().catch(() => '');
        throw new Error(`Fish Audio TTS failed (${ttsRes.status}): ${errText.slice(0, 350)}`);
      }

      const segFilePath = await decodeAudioResponseToFile(
        ttsRes,
        path.join(params.workDir, `ext_seg_${i}`),
      );
      results.push({
        filePath: segFilePath,
        startSec: seg.start,
        targetDurationSec: Math.max(0.4, seg.end - seg.start),
      });
    }
    return results;
  } finally {
    await fetch(`${baseOrigin}/model/${modelId}`, {
      method: 'DELETE',
      headers: fishAuthHeaders(),
    }).catch(() => {});
  }
}

export async function cloneAndSynthesizeWithExternalApi(params: {
  originalAudioPath: string;
  sourceTranscriptText?: string;
  targetLang: string;
  translation: LanguageTranslationResult;
  settings: DubbingSettings;
  originalDurationSec: number;
  workDir: string;
  onProgress?: (stageLabel: string, progressPct?: number | null) => void;
}): Promise<DubbingSynthesisResult> {
  const cfg = getConfig();
  if (!cfg.voiceCloneApiUrl) {
    throw new Error('VOICE_CLONE_API_URL is not configured.');
  }

  const {
    originalAudioPath,
    sourceTranscriptText,
    targetLang,
    translation,
    settings,
    originalDurationSec,
    workDir,
    onProgress,
  } = params;

  await fs.mkdir(workDir, { recursive: true });
  const sampleWavPath = path.join(workDir, 'voice_reference.wav');
  await prepareVoiceSampleWav(originalAudioPath, sampleWavPath, 60);
  const sampleBuf = await fs.readFile(sampleWavPath);
  const sampleBase64 = sampleBuf.toString('base64');

  const segments =
    translation.segments.length > 0
      ? translation.segments
      : [
          {
            id: 'seg_0',
            start: 0,
            end: originalDurationSec,
            sourceText: sourceTranscriptText ?? '',
            translatedText: translation.fullTranslatedText,
          },
        ];

  let segmentInputs: TimedAudioSegmentInput[] = [];

  if (cfg.voiceCloneFormat === 'cartesia') {
    segmentInputs = await synthesizeWithCartesia({
      apiUrl: cfg.voiceCloneApiUrl,
      sampleBuf,
      segments,
      targetLang,
      model: cfg.voiceCloneModel,
      workDir,
      onProgress: (label) => onProgress?.(label, null),
    });
  } else if (cfg.voiceCloneFormat === 'fish_audio') {
    segmentInputs = await synthesizeWithFishAudio({
      apiUrl: cfg.voiceCloneApiUrl,
      sampleBuf,
      sampleBase64,
      segments,
      sourceTranscriptText,
      model: cfg.voiceCloneModel,
      workDir,
      onProgress: (label) => onProgress?.(label, null),
    });
  } else {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      onProgress?.(
        `Cloning & synthesizing segment ${i + 1} of ${segments.length} (${cfg.voiceCloneFormat})`,
        null,
      );
      const outBase = path.join(workDir, `ext_seg_${i}`);
      let segFilePath = '';

      if (cfg.voiceCloneFormat === 'json_base64') {
        segFilePath = await synthesizeSegmentJsonBase64({
          apiUrl: cfg.voiceCloneApiUrl,
          sampleBase64,
          text: seg.translatedText,
          targetLang,
          sourceTranscriptText,
          settings,
          model: cfg.voiceCloneModel,
          outPathBase: outBase,
        });
      } else {
        segFilePath = await synthesizeSegmentMultipart({
          apiUrl: cfg.voiceCloneApiUrl,
          sampleBuf,
          text: seg.translatedText,
          targetLang,
          sourceTranscriptText,
          settings,
          model: cfg.voiceCloneModel,
          outPathBase: outBase,
        });
      }

      segmentInputs.push({
        filePath: segFilePath,
        startSec: seg.start,
        targetDurationSec: Math.max(0.4, seg.end - seg.start),
      });
    }
  }

  onProgress?.('Aligning pacing and assembling dubbed audio', null);
  const assembledWavPath = path.join(workDir, `external_clone_${targetLang}.wav`);
  await assembleTimedSegments(
    segmentInputs,
    originalDurationSec,
    assembledWavPath,
    path.join(workDir, 'seg_tmp'),
    settings.preserveRhythmAndPacing,
  );

  return {
    dubbedAudioPath: assembledWavPath,
    methodUsed: 'external_voice_clone_api',
  };
}

function cleanFishAsrText(raw: string): string {
  return raw
    .replace(/<\|speaker:\d+\|>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function groupFishAsrChunksIntoSegments(chunks: WordTimestamp[]): TranscriptSegment[] {
  const spoken = chunks.filter((w) => w.text.trim().length > 0);
  if (spoken.length === 0) return [];

  const segments: TranscriptSegment[] = [];
  let bucket: WordTimestamp[] = [];
  const sentenceEnd = /[.!?。！？]$/;

  const flush = () => {
    if (bucket.length === 0) return;
    const text = bucket
      .map((w) => w.text.trim())
      .join(' ')
      .replace(/\s+([,.!?;:)\]\}])/g, '$1')
      .trim();
    if (text) {
      segments.push({
        id: `seg_${segments.length}`,
        speakerId: bucket[0].speakerId ?? 'speaker_0',
        start: bucket[0].start,
        end: Math.max(bucket[bucket.length - 1].end, bucket[0].start + 0.2),
        text,
      });
    }
    bucket = [];
  };

  for (const chunk of spoken) {
    const prev = bucket[bucket.length - 1];
    if (prev) {
      const gap = chunk.start - prev.end;
      const span = chunk.end - bucket[0].start;
      const speakerChanged = chunk.speakerId && prev.speakerId && chunk.speakerId !== prev.speakerId;
      if (sentenceEnd.test(prev.text.trim()) || gap > 0.7 || span > 12 || speakerChanged) {
        flush();
      }
    }
    bucket.push(chunk);
  }
  flush();
  return segments;
}

export async function transcribeWithFishAudioAsr(
  audioPath: string,
  langHint?: string,
): Promise<SourceTranscription> {
  const cfg = getConfig();
  if (!cfg.voiceCloneApiKey) {
    throw new Error('VOICE_CLONE_API_KEY is required for Fish Audio ASR.');
  }

  const baseOrigin = (() => {
    try {
      return new URL(cfg.voiceCloneApiUrl || 'https://api.fish.audio/v1/tts').origin;
    } catch {
      return 'https://api.fish.audio';
    }
  })();

  const headers: Record<string, string> = (cfg.voiceCloneApiUrl || '').toLowerCase().includes('fish.audio') || !cfg.voiceCloneApiUrl
    ? { Authorization: `Bearer ${cfg.voiceCloneApiKey}` }
    : buildAuthHeaders();

  const audioBuf = await fs.readFile(audioPath);
  const form = new FormData();
  form.append('audio', new Blob([new Uint8Array(audioBuf)]), path.basename(audioPath));
  form.append('ignore_timestamps', 'false');
  if (langHint && langHint !== 'auto') {
    form.append('language', langHint);
  }

  const res = await fetch(`${baseOrigin}/v1/asr`, {
    method: 'POST',
    headers,
    body: form,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Fish Audio ASR failed (${res.status}): ${errText.slice(0, 350)}`);
  }

  const data = (await res.json()) as {
    text?: string;
    duration?: number;
    language?: string;
    language_code?: string;
    segments?: Array<{ text?: string; start?: number; end?: number }>;
    speaker_turns?: Array<{ speaker?: string; text?: string; start?: number; end?: number }>;
  };

  const rawSegments = Array.isArray(data.segments) && data.segments.length > 0
    ? data.segments.map((s) => ({
        text: cleanFishAsrText(s.text ?? ''),
        start: s.start,
        end: s.end,
        speakerId: 'speaker_0',
      }))
    : (data.speaker_turns ?? []).map((t) => ({
        text: cleanFishAsrText(t.text ?? ''),
        start: t.start,
        end: t.end,
        speakerId: t.speaker || 'speaker_0',
      }));

  const words: WordTimestamp[] = rawSegments
    .filter(
      (s): s is { text: string; start: number; end: number; speakerId: string } =>
        s.text.length > 0 && typeof s.start === 'number' && typeof s.end === 'number' && s.end >= s.start,
    )
    .map((s) => ({
      text: s.text,
      start: s.start,
      end: s.end,
      speakerId: s.speakerId,
    }));

  const fullText = cleanFishAsrText(data.text ?? '');
  if (!fullText && words.length === 0) {
    throw new Error('Fish Audio ASR did not detect intelligible speech in the audio.');
  }

  const segments = groupFishAsrChunksIntoSegments(words);
  const durationFallback = typeof data.duration === 'number' && data.duration > 0 ? data.duration : 10;

  return {
    languageCode: (data.language_code || (langHint && langHint !== 'auto' ? langHint : 'en')).toLowerCase(),
    text: fullText || segments.map((s) => s.text).join(' '),
    segments:
      segments.length > 0
        ? segments
        : [
            {
              id: 'seg_0',
              speakerId: 'speaker_0',
              start: 0,
              end: durationFallback,
              text: fullText,
            },
          ],
    words,
  };
}

