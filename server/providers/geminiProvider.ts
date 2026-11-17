import fs from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI, Type } from '@google/genai';
import { getConfig } from '../config.ts';
import type {
  DubbingSettings,
  LanguageTranslationResult,
  SourceTranscription,
  SupportedLanguage,
  TranscriptSegment,
  WordTimestamp,
} from '../types.ts';
import {
  assembleTimedSegments,
  convertToMp3,
  probeAudio,
  type TimedAudioSegmentInput,
} from '../utils/audioProcessor.ts';
import { ELEVENLABS_SUPPORTED_LANGUAGES } from './elevenlabsProvider.ts';
import type {
  DubbingSynthesisResult,
  SubtitleAlignmentResult,
  VoiceDubbingProvider,
} from './voiceProvider.ts';

const GEMINI_PREBUILT_VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'] as const;
type GeminiVoiceName = (typeof GEMINI_PREBUILT_VOICES)[number];

interface SpeakerVoiceProfile {
  voiceName: GeminiVoiceName;
  styleSummary: string;
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = getConfig().geminiApiKey;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in server secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatGeminiError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes('API_KEY_INVALID') || raw.includes('API key not valid')) {
    return new Error(
      'Gemini API key is invalid (API_KEY_INVALID). Open Settings → Secrets, set a valid GEMINI_API_KEY (39 characters starting with AIza), and restart the server.',
    );
  }
  if (raw.includes('PERMISSION_DENIED')) {
    return new Error(
      'Gemini API key permission denied (403). Verify GEMINI_API_KEY in Settings → Secrets has Generative Language API access enabled, and restart the server.',
    );
  }
  return err instanceof Error ? err : new Error(raw);
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isRetryable =
        msg.includes('429') ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        msg.includes('503') ||
        msg.includes('500') ||
        msg.includes('UNAVAILABLE');
      if (!isRetryable || attempt === maxAttempts) {
        throw formatGeminiError(err);
      }
      await sleep(1500 * attempt);
    }
  }
  throw formatGeminiError(lastErr);
}

async function loadAudioAsInlinePart(audioPath: string): Promise<{
  inlineData: { mimeType: string; data: string };
  cleanupPath?: string;
}> {
  // Always normalize to a valid, compact MP3 stream so mismatched file extensions
  // (e.g., WAV/PCM or M4A inside .mp3) decode cleanly in Gemini.
  const tmpMp3 = `${audioPath}.gemini_${Date.now()}.mp3`;
  await convertToMp3(audioPath, tmpMp3);
  const buf = await fs.readFile(tmpMp3);
  return {
    inlineData: {
      mimeType: 'audio/mp3',
      data: buf.toString('base64'),
    },
    cleanupPath: tmpMp3,
  };
}

function normalizeVoiceName(raw: string | undefined): GeminiVoiceName {
  const candidate = (raw ?? '').trim().toLowerCase();
  const matched = GEMINI_PREBUILT_VOICES.find((v) => v.toLowerCase() === candidate);
  return matched ?? 'Kore';
}

function buildStyleDirection(baseStyle: string, settings: DubbingSettings, targetLang: string): string {
  const directives: string[] = [];
  if (baseStyle.trim()) {
    directives.push(baseStyle.trim());
  }
  if (settings.preserveNarrationStyle) {
    directives.push('Preserve the original storytelling cadence, phrasing, and emphasis.');
  }
  if (settings.preserveEmotionalExpression) {
    directives.push('Retain natural emotional inflection and warmth.');
  }
  if (settings.preserveRhythmAndPacing) {
    directives.push('Keep natural conversational pacing without rushing.');
  }
  if (settings.preserveVocalCharacteristics) {
    directives.push('Speak clearly with natural studio-grade acoustic warmth.');
  }
  directives.push(`Speak naturally in ${targetLang}.`);
  return directives.join(' ');
}

export async function translateWithGeminiFallback(params: {
  sourceTranscription: SourceTranscription;
  sourceLanguageLabel: string;
  targetLanguageCode: string;
  targetLanguageName: string;
  settings: DubbingSettings;
}): Promise<LanguageTranslationResult> {
  const ai = getGeminiClient();
  const {
    sourceTranscription,
    sourceLanguageLabel,
    targetLanguageCode,
    targetLanguageName,
    settings,
  } = params;

  const preservationNotes = [
    settings.preserveNarrationStyle ? 'preserve narration style and rhetoric' : null,
    settings.preserveEmotionalExpression ? 'preserve emotional tone and intensity' : null,
    settings.preserveRhythmAndPacing
      ? 'match approximate spoken syllable duration per segment for natural lip/audio pacing'
      : null,
  ]
    .filter(Boolean)
    .join('; ');

  const prompt = [
    `Translate every segment below from ${sourceLanguageLabel} into natural, fluent ${targetLanguageName} (${targetLanguageCode}) for voice dubbing.`,
    preservationNotes ? `Guidelines: ${preservationNotes}.` : '',
    'You MUST preserve every exact segment id in your JSON response without omitting or merging any segment.',
    '',
    `Segments JSON: ${JSON.stringify(
      sourceTranscription.segments.map((s) => ({
        id: s.id,
        start: Number(s.start.toFixed(3)),
        end: Number(s.end.toFixed(3)),
        text: s.text,
      })),
    )}`,
  ]
    .filter(Boolean)
    .join('\n');

  const response = await withRetry(() =>
    ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
      config: {
        systemInstruction:
          'You are an expert multilingual dubbing script adapter. Always translate EVERY input segment id accurately into natural spoken phrasing.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            fullTranslation: { type: Type.STRING },
            segments: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  translatedText: { type: Type.STRING },
                },
                required: ['id', 'translatedText'],
              },
            },
          },
          required: ['fullTranslation', 'segments'],
        },
      },
    }),
  );

  const rawText = (response.text ?? '').trim();
  const parsed = JSON.parse(rawText) as {
    fullTranslation?: string;
    segments?: Array<{ id?: string; translatedText?: string }>;
  };

  const map = new Map<string, string>();
  for (const item of parsed.segments ?? []) {
    if (item.id && item.translatedText?.trim()) {
      map.set(item.id.trim(), item.translatedText.trim());
    }
  }

  const translatedSegments = sourceTranscription.segments.map((seg, idx) => {
    const matched = map.get(seg.id) || parsed.segments?.[idx]?.translatedText?.trim() || '';
    if (!matched) {
      throw new Error(`Gemini translation omitted segment ${seg.id}.`);
    }
    return {
      id: seg.id,
      start: seg.start,
      end: seg.end,
      sourceText: seg.text,
      translatedText: matched,
    };
  });

  const fullTranslatedText =
    parsed.fullTranslation?.trim() || translatedSegments.map((s) => s.translatedText).join(' ');

  return {
    targetLanguageCode,
    targetLanguageName,
    fullTranslatedText,
    segments: translatedSegments,
    llmModel: 'gemini-4-hydrogen',
  };
}

export class GeminiVoiceProvider implements VoiceDubbingProvider {
  readonly id = 'gemini';
  readonly name = 'Built-in Gemini';
  private readonly voiceProfileCache = new Map<string, SpeakerVoiceProfile>();

  getSupportedLanguages(): SupportedLanguage[] {
    return ELEVENLABS_SUPPORTED_LANGUAGES;
  }

  private async analyzeVoiceProfile(audioPath: string): Promise<SpeakerVoiceProfile> {
    const cached = this.voiceProfileCache.get(audioPath);
    if (cached) return cached;

    const ai = getGeminiClient();
    const { inlineData, cleanupPath } = await loadAudioAsInlinePart(audioPath);

    try {
      const response = await withRetry(() =>
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: {
            parts: [
              { inlineData },
              {
                text:
                  'Listen to the primary speaker in this audio and select the closest matching Gemini voice profile from: ' +
                  'Charon (deep, calm, authoritative male), Fenrir (warm, expressive male), ' +
                  'Puck (bright, energetic, youthful), Kore (clear, balanced female), Zephyr (soft, warm, natural female). ' +
                  'Also provide a short 1-sentence delivery style description (pitch, energy, tone, cadence) for TTS speechMetadata.',
              },
            ],
          },
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                voiceName: { type: Type.STRING },
                styleSummary: { type: Type.STRING },
              },
              required: ['voiceName', 'styleSummary'],
            },
          },
        }),
      );

      const parsed = JSON.parse((response.text ?? '{}').trim()) as {
        voiceName?: string;
        styleSummary?: string;
      };
      const profile: SpeakerVoiceProfile = {
        voiceName: normalizeVoiceName(parsed.voiceName),
        styleSummary:
          parsed.styleSummary?.trim() || 'Natural, expressive speaker with clear conversational pacing.',
      };
      this.voiceProfileCache.set(audioPath, profile);
      return profile;
    } catch {
      const fallback: SpeakerVoiceProfile = {
        voiceName: 'Kore',
        styleSummary: 'Clear, expressive speaker with natural conversational pacing.',
      };
      return fallback;
    } finally {
      if (cleanupPath) {
        await fs.rm(cleanupPath, { force: true }).catch(() => {});
      }
    }
  }

  async transcribeOriginalAudio(
    audioPath: string,
    sourceLangHint: string,
  ): Promise<SourceTranscription> {
    const ai = getGeminiClient();
    const probe = await probeAudio(audioPath);
    const durationSec = Math.max(0.5, probe.durationSec);
    const { inlineData, cleanupPath } = await loadAudioAsInlinePart(audioPath);

    try {
      const hintInstruction =
        sourceLangHint && sourceLangHint !== 'auto'
          ? `The spoken language is ${sourceLangHint}.`
          : 'Detect the primary spoken language accurately.';

      // Step 1: High-accuracy verbatim speech transcription via gemini-3.5-transcribe
      let rawTranscript = '';
      try {
        const transcribeRes = await withRetry(() =>
          ai.models.generateContent({
            model: 'gemini-3.5-transcribe',
            contents: {
              parts: [
                { inlineData },
                {
                  text:
                    sourceLangHint && sourceLangHint !== 'auto'
                      ? `Transcribe this audio in ${sourceLangHint}. Return only the spoken transcript.`
                      : 'Transcribe this audio.',
                },
              ],
            },
          }),
        );
        rawTranscript = (transcribeRes.text ?? '').trim();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('API_KEY_INVALID') || msg.includes('PERMISSION_DENIED') || msg.includes('403')) {
          throw err;
        }
        // Otherwise allow gemini-4-hydrogen below to transcribe & segment directly
      }

      // Step 2: Timestamped segmentation, vocal profile analysis (and transcription fallback if Step 1 was empty)
      const alignRes = await withRetry(() =>
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: {
            parts: [
              { inlineData },
              {
                text: [
                  `Listen carefully to this ${durationSec.toFixed(2)}-second audio recording.`,
                  hintInstruction,
                  rawTranscript
                    ? `Verbatim transcript reference:\n"""\n${rawTranscript}\n"""`
                    : 'Transcribe all spoken speech verbatim into fullTranscript and segments.',
                  'Split the spoken audio into chronological, non-overlapping natural sentence/phrase segments (each ~2 to 10 seconds long) with accurate startSec and endSec timestamps within [0, ' +
                    durationSec.toFixed(2) +
                    '].',
                  'Also identify the ISO 639-1 two-letter languageCode (e.g. "en", "ms", "ja", "zh", "es") and pick the closest matching Gemini voice from: Charon, Fenrir, Puck, Kore, Zephyr with a 1-sentence styleSummary.',
                ].join('\n\n'),
              },
            ],
          },
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                languageCode: { type: Type.STRING },
                fullTranscript: { type: Type.STRING },
                voiceName: { type: Type.STRING },
                styleSummary: { type: Type.STRING },
                segments: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      startSec: { type: Type.NUMBER },
                      endSec: { type: Type.NUMBER },
                      speakerId: { type: Type.STRING },
                      text: { type: Type.STRING },
                    },
                    required: ['startSec', 'endSec', 'text'],
                  },
                },
              },
              required: ['languageCode', 'fullTranscript', 'segments'],
            },
          },
        }),
      );

      const parsed = JSON.parse((alignRes.text ?? '{}').trim()) as {
        languageCode?: string;
        fullTranscript?: string;
        voiceName?: string;
        styleSummary?: string;
        segments?: Array<{
          startSec?: number;
          endSec?: number;
          speakerId?: string;
          text?: string;
        }>;
      };

      if (parsed.voiceName || parsed.styleSummary) {
        this.voiceProfileCache.set(audioPath, {
          voiceName: normalizeVoiceName(parsed.voiceName),
          styleSummary:
            parsed.styleSummary?.trim() || 'Natural, expressive speaker with clear conversational pacing.',
        });
      }

      const rawSegs = (parsed.segments ?? [])
        .filter((s) => typeof s.text === 'string' && s.text.trim().length > 0)
        .sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0));

      const segments: TranscriptSegment[] = [];
      let prevEnd = 0;

      for (const s of rawSegs) {
        const rawStart = typeof s.startSec === 'number' && Number.isFinite(s.startSec) ? s.startSec : prevEnd;
        const rawEnd =
          typeof s.endSec === 'number' && Number.isFinite(s.endSec)
            ? s.endSec
            : Math.min(durationSec, rawStart + 3);
        const start = Math.max(prevEnd, Math.min(rawStart, Math.max(0, durationSec - 0.2)));
        const end = Math.min(durationSec, Math.max(start + 0.2, rawEnd));
        if (end <= start) continue;

        segments.push({
          id: `seg_${segments.length}`,
          speakerId: s.speakerId?.trim() || 'speaker_0',
          start,
          end,
          text: s.text!.trim(),
        });
        prevEnd = end;
      }

      const finalTranscript =
        rawTranscript ||
        parsed.fullTranscript?.trim() ||
        segments.map((s) => s.text).join(' ').trim();

      if (!finalTranscript) {
        throw new Error('No intelligible speech was detected in the uploaded audio recording.');
      }

      if (segments.length === 0) {
        segments.push({
          id: 'seg_0',
          speakerId: 'speaker_0',
          start: 0,
          end: durationSec,
          text: finalTranscript,
        });
      }

      const words: WordTimestamp[] = segments.map((seg) => ({
        text: seg.text,
        start: seg.start,
        end: seg.end,
        speakerId: seg.speakerId,
      }));

      const detectedCode = (
        parsed.languageCode ||
        (sourceLangHint && sourceLangHint !== 'auto' ? sourceLangHint : 'en')
      )
        .trim()
        .toLowerCase()
        .slice(0, 5);

      return {
        languageCode: detectedCode || 'en',
        text: finalTranscript,
        segments,
        words,
      };
    } finally {
      if (cleanupPath) {
        await fs.rm(cleanupPath, { force: true }).catch(() => {});
      }
    }
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
    const ai = getGeminiClient();

    onProgress?.('Matching speaker voice profile & delivery style via Gemini', null);
    const voiceProfile = await this.analyzeVoiceProfile(originalAudioPath);
    const styleDirection = buildStyleDirection(
      voiceProfile.styleSummary,
      settings,
      translation.targetLanguageName || targetLang,
    );

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

    const segmentInputs: TimedAudioSegmentInput[] = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const spokenText = seg.translatedText.trim();
      if (!spokenText) continue;

      onProgress?.(
        `Synthesizing segment ${i + 1} of ${segments.length} (Gemini TTS · ${voiceProfile.voiceName})`,
        null,
      );

      let ttsRes;
      try {
        ttsRes = await withRetry(() =>
          ai.models.generateContent({
            model: 'gemini-3.8-flash-lite-tts',
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text: spokenText,
                    speechMetadata: {
                      style: styleDirection,
                    },
                  },
                ],
              },
            ],
            config: {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: voiceProfile.voiceName },
                },
              },
            },
          }),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Retry without speechMetadata if a specific language rejects metadata hints
        if (msg.toLowerCase().includes('speechmetadata') || msg.includes('400')) {
          ttsRes = await withRetry(() =>
            ai.models.generateContent({
              model: 'gemini-3.8-flash-lite-tts',
              contents: [
                {
                  role: 'user',
                  parts: [{ text: spokenText }],
                },
              ],
              config: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: voiceProfile.voiceName },
                  },
                },
              },
            }),
          );
        } else {
          throw err;
        }
      }

      const parts = ttsRes.candidates?.[0]?.content?.parts ?? [];
      const b64Audio = parts.find((p) => Boolean(p.inlineData?.data))?.inlineData?.data;
      if (!b64Audio) {
        throw new Error(`Gemini TTS did not return audio data for segment ${i + 1}.`);
      }

      const wavBuffer = Buffer.from(b64Audio, 'base64');
      if (wavBuffer.length <= 44) {
        throw new Error(`Gemini TTS returned an empty audio buffer for segment ${i + 1}.`);
      }

      const segPath = path.join(workDir, `gemini_seg_${i}.wav`);
      await fs.writeFile(segPath, wavBuffer);

      segmentInputs.push({
        filePath: segPath,
        startSec: seg.start,
        targetDurationSec: Math.max(0.4, seg.end - seg.start),
      });
    }

    if (segmentInputs.length === 0) {
      throw new Error('No dubbed speech segments were generated by Gemini TTS.');
    }

    onProgress?.('Aligning pacing and assembling dubbed audio', null);
    const assembledWavPath = path.join(workDir, `gemini_${targetLang}.wav`);
    await assembleTimedSegments(
      segmentInputs,
      originalDurationSec,
      assembledWavPath,
      path.join(workDir, 'seg_tmp'),
      settings.preserveRhythmAndPacing,
    );

    return {
      dubbedAudioPath: assembledWavPath,
      methodUsed: 'gemini_style_matched_tts',
      providerLimitationNotice: `Gemini-only mode used style-matched Gemini TTS (voice: ${voiceProfile.voiceName}) instead of external zero-shot voice cloning.`,
    };
  }

  async generateTimestampsForSubtitles(params: {
    dubbedAudioPath: string;
    targetLangCode: string;
    expectedText?: string;
  }): Promise<SubtitleAlignmentResult> {
    const ai = getGeminiClient();
    const { dubbedAudioPath, targetLangCode, expectedText } = params;
    const probe = await probeAudio(dubbedAudioPath);
    const durationSec = Math.max(0.4, probe.durationSec);
    const { inlineData, cleanupPath } = await loadAudioAsInlinePart(dubbedAudioPath);

    try {
      const response = await withRetry(() =>
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: {
            parts: [
              { inlineData },
              {
                text: [
                  `Listen closely to this ${durationSec.toFixed(2)}-second dubbed audio in language "${targetLangCode}".`,
                  expectedText?.trim()
                    ? `Spoken script reference:\n"""\n${expectedText.trim()}\n"""`
                    : '',
                  'Return chronological, non-overlapping subtitle phrase cues with exact startSec and endSec timestamps synchronized to when each phrase is spoken in the audio (strictly within 0 to ' +
                    durationSec.toFixed(2) +
                    ' seconds). Keep each cue concise (1-2 short subtitle lines, roughly 2 to 6 seconds per cue).',
                ]
                  .filter(Boolean)
                  .join('\n\n'),
              },
            ],
          },
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                cues: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      startSec: { type: Type.NUMBER },
                      endSec: { type: Type.NUMBER },
                      text: { type: Type.STRING },
                    },
                    required: ['startSec', 'endSec', 'text'],
                  },
                },
              },
              required: ['cues'],
            },
          },
        }),
      );

      const parsed = JSON.parse((response.text ?? '{}').trim()) as {
        cues?: Array<{ startSec?: number; endSec?: number; text?: string }>;
      };

      const words: WordTimestamp[] = [];
      let prevEnd = 0;

      for (const cue of (parsed.cues ?? []).sort((a, b) => (a.startSec ?? 0) - (b.startSec ?? 0))) {
        const text = (cue.text ?? '').trim();
        if (!text) continue;

        const rawStart =
          typeof cue.startSec === 'number' && Number.isFinite(cue.startSec) ? cue.startSec : prevEnd;
        const rawEnd =
          typeof cue.endSec === 'number' && Number.isFinite(cue.endSec)
            ? cue.endSec
            : Math.min(durationSec, rawStart + 2.5);

        const start = Math.max(prevEnd, Math.min(rawStart, Math.max(0, durationSec - 0.15)));
        const end = Math.min(durationSec, Math.max(start + 0.15, rawEnd));
        if (end <= start) continue;

        words.push({ text, start, end });
        prevEnd = end;
      }

      if (words.length === 0) {
        throw new Error('Gemini did not return valid timestamped subtitle cues.');
      }

      return {
        words,
        alignmentMethod: 'speech_recognition',
      };
    } finally {
      if (cleanupPath) {
        await fs.rm(cleanupPath, { force: true }).catch(() => {});
      }
    }
  }
}
