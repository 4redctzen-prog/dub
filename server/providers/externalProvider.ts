import fs from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '../config.ts';
import type {
  DubbingSettings,
  LanguageTranslationResult,
  SourceTranscription,
  SupportedLanguage,
  TranscriptSegment,
  WordTimestamp,
} from '../types.ts';
import { ELEVENLABS_SUPPORTED_LANGUAGES, ElevenLabsProvider } from './elevenlabsProvider.ts';
import {
  cloneAndSynthesizeWithExternalApi,
  transcribeWithFishAudioAsr,
} from './externalVoiceCloner.ts';
import type {
  DubbingSynthesisResult,
  SubtitleAlignmentResult,
  VoiceDubbingProvider,
} from './voiceProvider.ts';

function groupWords(words: WordTimestamp[]): TranscriptSegment[] {
  const spoken = words.filter((w) => w.text.trim().length > 0);
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
        speakerId: 'speaker_0',
        start: bucket[0].start,
        end: Math.max(bucket[bucket.length - 1].end, bucket[0].start + 0.2),
        text,
      });
    }
    bucket = [];
  };

  for (const w of spoken) {
    const prev = bucket[bucket.length - 1];
    if (prev && (sentenceEnd.test(prev.text.trim()) || w.start - prev.end > 0.7 || w.end - bucket[0].start > 12)) {
      flush();
    }
    bucket.push(w);
  }
  flush();
  return segments;
}

async function transcribeViaWhisperEndpoint(
  audioPath: string,
  langHint?: string,
): Promise<{ languageCode: string; text: string; words: WordTimestamp[]; segments: TranscriptSegment[] }> {
  const cfg = getConfig();
  if (!cfg.sttApiUrl) {
    throw new Error('STT_API_URL is not configured.');
  }

  const audioBuf = await fs.readFile(audioPath);
  const form = new FormData();
  form.append('file', new Blob([audioBuf]), path.basename(audioPath));
  form.append('model', cfg.sttModel || 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('timestamp_granularities[]', 'segment');
  if (langHint && langHint !== 'auto') {
    form.append('language', langHint);
  }

  const headers: Record<string, string> = {};
  if (cfg.sttApiKey) {
    headers.Authorization = `Bearer ${cfg.sttApiKey}`;
  }

  const res = await fetch(cfg.sttApiUrl, {
    method: 'POST',
    headers,
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`External STT API failed (${res.status}): ${detail.slice(0, 350)}`);
  }

  const data = (await res.json()) as {
    language?: string;
    text?: string;
    words?: Array<{ word?: string; text?: string; start?: number; end?: number }>;
    segments?: Array<{ id?: number | string; start?: number; end?: number; text?: string }>;
  };

  const words: WordTimestamp[] = (data.words ?? [])
    .filter((w) => typeof w.start === 'number' && typeof w.end === 'number' && (w.word || w.text))
    .map((w) => ({
      text: (w.word ?? w.text ?? '').trim(),
      start: w.start!,
      end: w.end!,
    }))
    .filter((w) => w.text.length > 0);

  const segments: TranscriptSegment[] =
    words.length > 0
      ? groupWords(words)
      : (data.segments ?? [])
          .filter((s) => typeof s.start === 'number' && typeof s.end === 'number' && s.text)
          .map((s, idx) => ({
            id: `seg_${idx}`,
            speakerId: 'speaker_0',
            start: s.start!,
            end: s.end!,
            text: s.text!.trim(),
          }));

  const fullText = (data.text ?? '').trim() || segments.map((s) => s.text).join(' ');
  return {
    languageCode: data.language || (langHint && langHint !== 'auto' ? langHint : 'en'),
    text: fullText,
    words,
    segments,
  };
}

export class ExternalVoiceProvider implements VoiceDubbingProvider {
  readonly id = 'external';
  readonly name = 'External Voice Cloning API';
  private readonly elevenLabsHelper = new ElevenLabsProvider();

  getSupportedLanguages(): SupportedLanguage[] {
    return ELEVENLABS_SUPPORTED_LANGUAGES;
  }

  async transcribeOriginalAudio(audioPath: string, sourceLangHint: string): Promise<SourceTranscription> {
    const cfg = getConfig();
    if (cfg.sttApiUrl) {
      return transcribeViaWhisperEndpoint(audioPath, sourceLangHint);
    }
    if (cfg.voiceCloneFormat === 'fish_audio' && cfg.voiceCloneApiKey) {
      return transcribeWithFishAudioAsr(audioPath, sourceLangHint);
    }
    if (cfg.elevenLabsApiKey) {
      return this.elevenLabsHelper.transcribeOriginalAudio(audioPath, sourceLangHint);
    }
    throw new Error(
      'No Speech-to-Text provider configured. Set STT_API_URL (Whisper-compatible), Fish Audio credentials, or ELEVENLABS_API_KEY.',
    );
  }

  async dubWithExternalTranslation(params: {
    originalAudioPath: string;
    sourceLang: string;
    sourceTranscriptText?: string;
    targetLang: string;
    translation: LanguageTranslationResult;
    settings: DubbingSettings;
    originalDurationSec: number;
    workDir: string;
    onProgress?: (stageLabel: string, progressPct?: number | null) => void;
  }): Promise<DubbingSynthesisResult> {
    return cloneAndSynthesizeWithExternalApi(params);
  }

  async generateTimestampsForSubtitles(params: {
    dubbedAudioPath: string;
    targetLangCode: string;
    expectedText?: string;
    providerSrtTranscript?: string;
  }): Promise<SubtitleAlignmentResult> {
    const cfg = getConfig();
    if (cfg.sttApiUrl) {
      const result = await transcribeViaWhisperEndpoint(params.dubbedAudioPath, params.targetLangCode);
      if (result.words.length > 0) {
        return { words: result.words, alignmentMethod: 'speech_recognition' };
      }
      // Fallback to segment-level tokens from Whisper if word-level wasn't returned by that server
      const segTokens: WordTimestamp[] = result.segments.map((s) => ({
        text: s.text,
        start: s.start,
        end: s.end,
      }));
      if (segTokens.length > 0) {
        return { words: segTokens, alignmentMethod: 'speech_recognition' };
      }
    }
    if (cfg.voiceCloneFormat === 'fish_audio' && cfg.voiceCloneApiKey) {
      const fishAsr = await transcribeWithFishAudioAsr(params.dubbedAudioPath, params.targetLangCode);
      const words: WordTimestamp[] =
        fishAsr.words.length > 0
          ? fishAsr.words
          : fishAsr.segments.map((s) => ({ text: s.text, start: s.start, end: s.end }));
      if (words.length > 0) {
        return { words, alignmentMethod: 'speech_recognition' };
      }
    }
    if (cfg.elevenLabsApiKey) {
      return this.elevenLabsHelper.generateTimestampsForSubtitles(params);
    }
    throw new Error('Cannot align subtitles: set STT_API_URL, Fish Audio credentials, or ELEVENLABS_API_KEY.');
  }
}
