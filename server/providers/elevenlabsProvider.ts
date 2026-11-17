import fs from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '../config.ts';
import {
  assembleTimedSegments,
  prepareVoiceSampleWav,
  type TimedAudioSegmentInput,
} from '../utils/audioProcessor.ts';
import type {
  DubbingSettings,
  LanguageTranslationResult,
  SourceTranscription,
  SupportedLanguage,
  TranscriptSegment,
  WordTimestamp,
} from '../types.ts';
import {
  cloneAndSynthesizeWithExternalApi,
  transcribeWithFishAudioAsr,
} from './externalVoiceCloner.ts';
import type {
  DubbingSynthesisResult,
  SubtitleAlignmentResult,
  VoiceDubbingProvider,
} from './voiceProvider.ts';

const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io/v1';

// Curated languages supported by ElevenLabs Dubbing API & Multilingual synthesis
export const ELEVENLABS_SUPPORTED_LANGUAGES: SupportedLanguage[] = [
  { code: 'en', name: 'English', nativeName: 'English', filenameSlug: 'english' },
  { code: 'ms', name: 'Malay', nativeName: 'Bahasa Melayu', filenameSlug: 'malay' },
  { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia', filenameSlug: 'indonesian' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語', filenameSlug: 'japanese' },
  { code: 'ko', name: 'Korean', nativeName: '한국어', filenameSlug: 'korean' },
  { code: 'zh', name: 'Mandarin Chinese', nativeName: '中文', filenameSlug: 'mandarin_chinese' },
  { code: 'es', name: 'Spanish', nativeName: 'Español', filenameSlug: 'spanish' },
  { code: 'fr', name: 'French', nativeName: 'Français', filenameSlug: 'french' },
  { code: 'de', name: 'German', nativeName: 'Deutsch', filenameSlug: 'german' },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', filenameSlug: 'arabic' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', filenameSlug: 'hindi' },
  { code: 'th', name: 'Thai', nativeName: 'ไทย', filenameSlug: 'thai' },
  { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt', filenameSlug: 'vietnamese' },
  { code: 'pt', name: 'Portuguese', nativeName: 'Português', filenameSlug: 'portuguese' },
  { code: 'it', name: 'Italian', nativeName: 'Italiano', filenameSlug: 'italian' },
  { code: 'nl', name: 'Dutch', nativeName: 'Nederlands', filenameSlug: 'dutch' },
  { code: 'pl', name: 'Polish', nativeName: 'Polski', filenameSlug: 'polish' },
  { code: 'tr', name: 'Turkish', nativeName: 'Türkçe', filenameSlug: 'turkish' },
  { code: 'fil', name: 'Filipino', nativeName: 'Filipino', filenameSlug: 'filipino' },
  { code: 'ta', name: 'Tamil', nativeName: 'தமிழ்', filenameSlug: 'tamil' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', filenameSlug: 'russian' },
  { code: 'uk', name: 'Ukrainian', nativeName: 'Українська', filenameSlug: 'ukrainian' },
  { code: 'sv', name: 'Swedish', nativeName: 'Svenska', filenameSlug: 'swedish' },
];

// ElevenLabs Multilingual v2 supports 29 languages (excludes Thai & Vietnamese);
// ElevenLabs v3 supports 70+ languages including Thai & Vietnamese.
const MULTILINGUAL_V2_UNSUPPORTED = new Set(['th', 'vi']);

function requireApiKey(): string {
  const key = getConfig().elevenLabsApiKey;
  if (!key) {
    throw new Error('ElevenLabs API key is missing. Set ELEVENLABS_API_KEY in server environment variables.');
  }
  return key;
}

async function parseErrorDetail(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const json = JSON.parse(text) as { detail?: string | { message?: string; status?: string } };
    if (typeof json.detail === 'string') return json.detail;
    if (json.detail?.message) return json.detail.message;
  } catch {
    // Ignore JSON parse error
  }
  return text.slice(0, 350) || `HTTP ${res.status}`;
}

function groupWordsIntoSegments(words: WordTimestamp[]): TranscriptSegment[] {
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
        speakerId: bucket[0].speakerId ?? 'speaker_0',
        start: bucket[0].start,
        end: Math.max(bucket[bucket.length - 1].end, bucket[0].start + 0.2),
        text,
      });
    }
    bucket = [];
  };

  for (const word of spoken) {
    const prev = bucket[bucket.length - 1];
    if (prev) {
      const gap = word.start - prev.end;
      const span = word.end - bucket[0].start;
      const speakerChanged = word.speakerId && prev.speakerId && word.speakerId !== prev.speakerId;
      if (sentenceEnd.test(prev.text.trim()) || gap > 0.7 || span > 12 || speakerChanged) {
        flush();
      }
    }
    bucket.push(word);
  }
  flush();
  return segments;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ElevenLabsProvider implements VoiceDubbingProvider {
  readonly id = 'elevenlabs';
  readonly name = 'ElevenLabs';

  getSupportedLanguages(): SupportedLanguage[] {
    return ELEVENLABS_SUPPORTED_LANGUAGES;
  }

  async transcribeOriginalAudio(audioPath: string, sourceLangHint: string): Promise<SourceTranscription> {
    const apiKey = requireApiKey();
    const audioBuf = await fs.readFile(audioPath);
    const filename = path.basename(audioPath);

    const form = new FormData();
    form.append('file', new Blob([audioBuf]), filename);
    form.append('model_id', 'scribe_v2');
    form.append('timestamps_granularity', 'word');
    form.append('diarize', 'true');
    if (sourceLangHint && sourceLangHint !== 'auto') {
      form.append('language_code', sourceLangHint);
    }

    const res = await fetch(`${ELEVENLABS_BASE_URL}/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
    });

    if (!res.ok) {
      const detail = await parseErrorDetail(res);
      const cfg = getConfig();
      const canFallbackToFishAsr =
        (res.status === 400 || res.status === 401 || res.status === 403) &&
        cfg.voiceCloneFormat === 'fish_audio' &&
        Boolean(cfg.voiceCloneApiKey);

      if (canFallbackToFishAsr) {
        try {
          return await transcribeWithFishAudioAsr(audioPath, sourceLangHint);
        } catch (fishErr) {
          const fishMsg = fishErr instanceof Error ? fishErr.message : String(fishErr);
          throw new Error(
            `Speech-to-text transcription failed (${res.status}): ${detail} | Fish Audio ASR fallback also failed: ${fishMsg}`,
          );
        }
      }
      throw new Error(`Speech-to-text transcription failed (${res.status}): ${detail}`);
    }

    const data = (await res.json()) as {
      language_code?: string;
      text?: string;
      words?: Array<{ text?: string; type?: string; start?: number; end?: number; speaker_id?: string }>;
    };

    const words: WordTimestamp[] = (data.words ?? [])
      .filter((w) => w.type !== 'spacing' && typeof w.text === 'string' && typeof w.start === 'number' && typeof w.end === 'number')
      .map((w) => ({
        text: w.text!.trim(),
        start: w.start!,
        end: w.end!,
        speakerId: w.speaker_id,
      }))
      .filter((w) => w.text.length > 0);

    const fullText = (data.text ?? '').trim();
    if (!fullText && words.length === 0) {
      throw new Error('No intelligible speech was detected in the uploaded audio recording.');
    }

    const segments = groupWordsIntoSegments(words);
    return {
      languageCode: data.language_code ?? (sourceLangHint !== 'auto' ? sourceLangHint : 'en'),
      text: fullText || segments.map((s) => s.text).join(' '),
      segments:
        segments.length > 0
          ? segments
          : [
              {
                id: 'seg_0',
                speakerId: 'speaker_0',
                start: 0,
                end: 10,
                text: fullText,
              },
            ],
      words,
    };
  }

  /**
   * Attempts ElevenLabs Dubbing Studio (external translation injection) first when workflowMode === 'auto'.
   * If the configured ElevenLabs account does not permit Dubbing Studio external translation injection
   * (Enterprise restriction), surfaces the limitation transparently and falls back to Audio-Conditioned
   * Instant Voice Cloning + External LLM Translated Synthesis (preserving the user's LLM without double-translating).
   */
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
      sourceLang,
      sourceTranscriptText,
      targetLang,
      translation,
      settings,
      originalDurationSec,
      workDir,
      onProgress,
    } = params;

    await fs.mkdir(workDir, { recursive: true });

    if (settings.workflowMode === 'native_dubbing') {
      onProgress?.('Running ElevenLabs native audio-to-audio dubbing', null);
      return this.runNativeDubbingApi({
        originalAudioPath,
        sourceLang,
        targetLang,
        workDir,
        limitationNotice:
          'Native Audio-to-Audio Dubbing mode was selected: ElevenLabs performed provider-internal dubbing directly from the source audio.',
        onProgress,
      });
    }

    // If an external Voice Cloning API (VOICE_CLONE_API_URL) is configured,
    // use it for the voice cloning & speech synthesis step while keeping ElevenLabs for STT/SRT alignment.
    const cfg = getConfig();
    if (cfg.voiceCloneApiUrl) {
      onProgress?.(`Cloning voice via configured external API (${cfg.voiceCloneFormat})`, null);
      return cloneAndSynthesizeWithExternalApi({
        originalAudioPath,
        sourceTranscriptText,
        targetLang,
        translation,
        settings,
        originalDurationSec,
        workDir,
        onProgress,
      });
    }

    if (settings.workflowMode === 'clone_tts') {
      onProgress?.('Cloning original speaker voice and synthesizing external LLM script', null);
      return this.runAudioConditionedCloneAndLlm({
        originalAudioPath,
        targetLang,
        translation,
        settings,
        originalDurationSec,
        workDir,
        onProgress,
      });
    }

    // workflowMode === 'auto':
    // 1. Prefer ElevenLabs Dubbing Studio if the account supports external translation injection.
    let studioLimitationReason = '';
    try {
      onProgress?.('Checking ElevenLabs Dubbing Studio external translation support', null);
      const studioResult = await this.tryDubbingStudioWithExternalTranslation({
        originalAudioPath,
        sourceLang,
        targetLang,
        translation,
        workDir,
        onProgress,
      });
      return studioResult;
    } catch (err) {
      studioLimitationReason = err instanceof Error ? err.message : String(err);
    }

    // 2. Dubbing Studio external translation injection is restricted or unavailable on this account:
    // Report the exact limitation clearly and execute Audio-Conditioned Voice Clone + External LLM synthesis
    // so the user's LLM translation is honored and never silently bypassed.
    const notice = `ElevenLabs Dubbing Studio external translation injection is not available on the configured account (${studioLimitationReason}). Used Audio-Conditioned Speaker Voice Cloning with your External LLM translation instead.`;

    onProgress?.('Generating cloned speaker voice with external LLM translation', null);
    const clonedResult = await this.runAudioConditionedCloneAndLlm({
      originalAudioPath,
      targetLang,
      translation,
      settings,
      originalDurationSec,
      workDir,
      onProgress,
    });

    return {
      ...clonedResult,
      providerLimitationNotice: notice,
    };
  }

  private async tryDubbingStudioWithExternalTranslation(params: {
    originalAudioPath: string;
    sourceLang: string;
    targetLang: string;
    translation: LanguageTranslationResult;
    workDir: string;
    onProgress?: (stageLabel: string, progressPct?: number | null) => void;
  }): Promise<DubbingSynthesisResult> {
    const apiKey = requireApiKey();
    const { originalAudioPath, sourceLang, targetLang, translation, workDir, onProgress } = params;
    const audioBuf = await fs.readFile(originalAudioPath);

    const form = new FormData();
    form.append('file', new Blob([audioBuf]), path.basename(originalAudioPath));
    form.append('target_lang', targetLang);
    if (sourceLang && sourceLang !== 'auto') {
      form.append('source_lang', sourceLang);
    } else {
      form.append('source_lang', 'auto');
    }
    form.append('dubbing_studio', 'true');
    form.append('drop_background_audio', 'false');

    const createRes = await fetch(`${ELEVENLABS_BASE_URL}/dubbing`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
    });

    if (!createRes.ok) {
      const detail = await parseErrorDetail(createRes);
      throw new Error(detail);
    }

    const created = (await createRes.json()) as { dubbing_id?: string };
    if (!created.dubbing_id) {
      throw new Error('ElevenLabs did not return a dubbing_id.');
    }

    const dubbingId = created.dubbing_id;

    try {
      // Poll until project metadata is ready
      for (let i = 0; i < 90; i++) {
        await sleep(2500);
        const metaRes = await fetch(`${ELEVENLABS_BASE_URL}/dubbing/${dubbingId}`, {
          headers: { 'xi-api-key': apiKey },
        });
        if (!metaRes.ok) {
          throw new Error(await parseErrorDetail(metaRes));
        }
        const meta = (await metaRes.json()) as { status?: string; editable?: boolean; error?: string };
        if (meta.status === 'failed') {
          throw new Error(meta.error || 'ElevenLabs Dubbing Studio job failed.');
        }
        if (meta.status === 'dubbed') {
          if (!meta.editable) {
            throw new Error('Account dubbing project is not editable for external translation injection.');
          }
          break;
        }
        onProgress?.(`Processing Dubbing Studio resource (${meta.status ?? 'dubbing'})`, null);
      }

      // Inspect dubbing resource to patch target segments with external LLM translation
      const resourceRes = await fetch(`${ELEVENLABS_BASE_URL}/dubbing/resource/${dubbingId}`, {
        headers: { 'xi-api-key': apiKey },
      });
      if (!resourceRes.ok) {
        const detail = await parseErrorDetail(resourceRes);
        throw new Error(`Dubbing Resource editing unavailable (${resourceRes.status}): ${detail}`);
      }

      const resource = (await resourceRes.json()) as {
        speaker_segments?: Record<string, { id?: string; start_time?: number; end_time?: number }>;
      };

      const segmentEntries = Object.values(resource.speaker_segments ?? {});
      if (segmentEntries.length === 0) {
        throw new Error('Dubbing Resource returned no editable segments.');
      }

      // Map external LLM translation segments onto provider segments
      for (let idx = 0; idx < segmentEntries.length; idx++) {
        const provSeg = segmentEntries[idx];
        if (!provSeg.id) continue;
        const translatedText =
          idx === 0 && segmentEntries.length === 1
            ? translation.fullTranslatedText
            : translation.segments[idx]?.translatedText;

        if (!translatedText) continue;

        const patchRes = await fetch(
          `${ELEVENLABS_BASE_URL}/dubbing/resource/${dubbingId}/segment/${provSeg.id}/${targetLang}`,
          {
            method: 'PATCH',
            headers: {
              'xi-api-key': apiKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text: translatedText }),
          },
        );
        if (!patchRes.ok) {
          throw new Error(`Segment translation patch restricted (${patchRes.status}): ${await parseErrorDetail(patchRes)}`);
        }
      }

      // Render updated translation
      const renderRes = await fetch(`${ELEVENLABS_BASE_URL}/dubbing/resource/${dubbingId}/render/${targetLang}`, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ render_type: 'mp3', normalize_volume: true }),
      });

      if (!renderRes.ok) {
        throw new Error(`Dubbing Studio render restricted (${renderRes.status}): ${await parseErrorDetail(renderRes)}`);
      }

      // Download rendered dubbed audio
      const audioRes = await fetch(`${ELEVENLABS_BASE_URL}/dubbing/${dubbingId}/audio/${targetLang}`, {
        headers: { 'xi-api-key': apiKey },
      });
      if (!audioRes.ok) {
        throw new Error(`Failed to download dubbed audio (${audioRes.status}): ${await parseErrorDetail(audioRes)}`);
      }

      const outPath = path.join(workDir, `studio_${targetLang}.mp3`);
      await fs.writeFile(outPath, Buffer.from(await audioRes.arrayBuffer()));

      return {
        dubbedAudioPath: outPath,
        methodUsed: 'dubbing_studio_external_llm',
      };
    } finally {
      // Clean up remote dubbing project if needed or leave safely
      await fetch(`${ELEVENLABS_BASE_URL}/dubbing/${dubbingId}`, {
        method: 'DELETE',
        headers: { 'xi-api-key': apiKey },
      }).catch(() => {});
    }
  }

  private async runAudioConditionedCloneAndLlm(params: {
    originalAudioPath: string;
    targetLang: string;
    translation: LanguageTranslationResult;
    settings: DubbingSettings;
    originalDurationSec: number;
    workDir: string;
    onProgress?: (stageLabel: string, progressPct?: number | null) => void;
  }): Promise<DubbingSynthesisResult> {
    const apiKey = requireApiKey();
    const { originalAudioPath, targetLang, translation, settings, originalDurationSec, workDir, onProgress } = params;

    // 1. Prepare clean audio reference sample from original recording for voice cloning
    const sampleWavPath = path.join(workDir, 'voice_reference.wav');
    await prepareVoiceSampleWav(originalAudioPath, sampleWavPath, 90);
    const sampleBuf = await fs.readFile(sampleWavPath);

    onProgress?.('Cloning original speaker vocal characteristics', null);

    const cloneForm = new FormData();
    cloneForm.append('name', `dub_temp_${Date.now()}`);
    cloneForm.append('remove_background_noise', 'true');
    cloneForm.append('description', 'Temporary audio-conditioned voice clone for multilingual dubbing');
    cloneForm.append('files', new Blob([sampleBuf], { type: 'audio/wav' }), 'voice_reference.wav');

    const cloneRes = await fetch(`${ELEVENLABS_BASE_URL}/voices/add`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: cloneForm,
    });

    if (!cloneRes.ok) {
      const detail = await parseErrorDetail(cloneRes);
      throw new Error(
        `Voice cloning failed (${cloneRes.status}): ${detail}. Ensure your ElevenLabs account tier supports Instant Voice Cloning.`,
      );
    }

    const { voice_id: voiceId } = (await cloneRes.json()) as { voice_id?: string };
    if (!voiceId) {
      throw new Error('ElevenLabs did not return a voice_id after cloning the original speaker.');
    }

    try {
      // Choose optimal multilingual model for the target language
      const modelId = MULTILINGUAL_V2_UNSUPPORTED.has(targetLang.toLowerCase())
        ? 'eleven_v3'
        : 'eleven_multilingual_v2';

      // Configure voice settings aligned with preservation options
      const stability = settings.preserveEmotionalExpression ? 0.38 : 0.65;
      const similarityBoost = settings.preserveSpeakerIdentity || settings.preserveVocalCharacteristics ? 0.88 : 0.65;
      const style = settings.preserveNarrationStyle ? 0.35 : 0.0;

      const segmentInputs: TimedAudioSegmentInput[] = [];
      const segments = translation.segments.length > 0
        ? translation.segments
        : [
            {
              id: 'seg_0',
              start: 0,
              end: originalDurationSec,
              sourceText: '',
              translatedText: translation.fullTranslatedText,
            },
          ];

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        onProgress?.(`Synthesizing segment ${i + 1} of ${segments.length}`, null);

        const prevText = i > 0 ? segments[i - 1].translatedText : undefined;
        const nextText = i < segments.length - 1 ? segments[i + 1].translatedText : undefined;

        const payload: Record<string, unknown> = {
          text: seg.translatedText,
          model_id: modelId,
          voice_settings: {
            stability,
            similarity_boost: similarityBoost,
            style,
            use_speaker_boost: true,
          },
        };

        if (modelId === 'eleven_multilingual_v2') {
          if (prevText) payload.previous_text = prevText;
          if (nextText) payload.next_text = nextText;
        }
        // Pass language_code when supported by TTS endpoint
        if (targetLang && modelId === 'eleven_v3') {
          payload.language_code = targetLang;
        }

        let ttsRes = await fetch(`${ELEVENLABS_BASE_URL}/text-to-speech/${voiceId}`, {
          method: 'POST',
          headers: {
            'xi-api-key': apiKey,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
          },
          body: JSON.stringify(payload),
        });

        // Graceful model fallback for Vietnamese if eleven_v3 isn't enabled on account
        if (!ttsRes.ok && targetLang.toLowerCase() === 'vi' && modelId === 'eleven_v3') {
          ttsRes = await fetch(`${ELEVENLABS_BASE_URL}/text-to-speech/${voiceId}`, {
            method: 'POST',
            headers: {
              'xi-api-key': apiKey,
              'Content-Type': 'application/json',
              Accept: 'audio/mpeg',
            },
            body: JSON.stringify({
              ...payload,
              model_id: 'eleven_flash_v2_5',
              language_code: 'vi',
            }),
          });
        }

        if (!ttsRes.ok) {
          throw new Error(`ElevenLabs TTS failed (${ttsRes.status}): ${await parseErrorDetail(ttsRes)}`);
        }

        const segMp3Path = path.join(workDir, `tts_seg_${i}.mp3`);
        await fs.writeFile(segMp3Path, Buffer.from(await ttsRes.arrayBuffer()));

        segmentInputs.push({
          filePath: segMp3Path,
          startSec: seg.start,
          targetDurationSec: Math.max(0.4, seg.end - seg.start),
        });
      }

      onProgress?.('Aligning pacing and assembling dubbed audio', null);
      const assembledWavPath = path.join(workDir, `assembled_${targetLang}.wav`);
      await assembleTimedSegments(
        segmentInputs,
        originalDurationSec,
        assembledWavPath,
        path.join(workDir, 'seg_tmp'),
        settings.preserveRhythmAndPacing,
      );

      return {
        dubbedAudioPath: assembledWavPath,
        methodUsed: 'audio_conditioned_clone_llm',
      };
    } finally {
      // Always clean up temporary cloned voice in ElevenLabs
      await fetch(`${ELEVENLABS_BASE_URL}/voices/${voiceId}`, {
        method: 'DELETE',
        headers: { 'xi-api-key': apiKey },
      }).catch(() => {});
    }
  }

  private async runNativeDubbingApi(params: {
    originalAudioPath: string;
    sourceLang: string;
    targetLang: string;
    workDir: string;
    limitationNotice?: string;
    onProgress?: (stageLabel: string, progressPct?: number | null) => void;
  }): Promise<DubbingSynthesisResult> {
    const apiKey = requireApiKey();
    const { originalAudioPath, sourceLang, targetLang, workDir, limitationNotice, onProgress } = params;
    const audioBuf = await fs.readFile(originalAudioPath);

    const form = new FormData();
    form.append('file', new Blob([audioBuf]), path.basename(originalAudioPath));
    form.append('target_lang', targetLang);
    form.append('source_lang', sourceLang && sourceLang !== 'auto' ? sourceLang : 'auto');
    form.append('drop_background_audio', 'false');

    const createRes = await fetch(`${ELEVENLABS_BASE_URL}/dubbing`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
    });

    if (!createRes.ok) {
      throw new Error(`ElevenLabs Dubbing API failed (${createRes.status}): ${await parseErrorDetail(createRes)}`);
    }

    const { dubbing_id: dubbingId } = (await createRes.json()) as { dubbing_id?: string };
    if (!dubbingId) {
      throw new Error('ElevenLabs Dubbing API did not return a dubbing_id.');
    }

    try {
      for (let i = 0; i < 120; i++) {
        await sleep(3000);
        const metaRes = await fetch(`${ELEVENLABS_BASE_URL}/dubbing/${dubbingId}`, {
          headers: { 'xi-api-key': apiKey },
        });
        if (!metaRes.ok) {
          throw new Error(`Polling dubbing status failed (${metaRes.status}): ${await parseErrorDetail(metaRes)}`);
        }
        const meta = (await metaRes.json()) as { status?: string; error?: string };
        if (meta.status === 'failed') {
          throw new Error(meta.error || 'ElevenLabs Dubbing failed.');
        }
        if (meta.status === 'dubbed') {
          break;
        }
        onProgress?.(`ElevenLabs Dubbing status: ${meta.status ?? 'processing'}`, null);
      }

      const audioRes = await fetch(`${ELEVENLABS_BASE_URL}/dubbing/${dubbingId}/audio/${targetLang}`, {
        headers: { 'xi-api-key': apiKey },
      });
      if (!audioRes.ok) {
        throw new Error(`Failed to fetch dubbed audio (${audioRes.status}): ${await parseErrorDetail(audioRes)}`);
      }

      const outPath = path.join(workDir, `native_${targetLang}.mp3`);
      await fs.writeFile(outPath, Buffer.from(await audioRes.arrayBuffer()));

      let providerSrtTranscript: string | undefined;
      try {
        const srtRes = await fetch(
          `${ELEVENLABS_BASE_URL}/dubbing/${dubbingId}/transcript/${targetLang}?format_type=srt`,
          { headers: { 'xi-api-key': apiKey } },
        );
        if (srtRes.ok) {
          providerSrtTranscript = await srtRes.text();
        }
      } catch {
        // Non-fatal; STT will transcribe the final audio for SRT
      }

      return {
        dubbedAudioPath: outPath,
        methodUsed: 'native_provider_dubbing',
        providerLimitationNotice: limitationNotice,
        providerSrtTranscript,
      };
    } finally {
      await fetch(`${ELEVENLABS_BASE_URL}/dubbing/${dubbingId}`, {
        method: 'DELETE',
        headers: { 'xi-api-key': apiKey },
      }).catch(() => {});
    }
  }

  /**
   * Generates accurate timestamps synchronized directly to the final dubbed audio.
   * Uses ElevenLabs Forced Alignment when expected spoken text is available;
   * otherwise (or if forced alignment is unsupported for that audio/script) runs
   * timestamped Speech-to-Text (Scribe v2) directly on the generated audio.
   */
  async generateTimestampsForSubtitles(params: {
    dubbedAudioPath: string;
    targetLangCode: string;
    expectedText?: string;
    providerSrtTranscript?: string;
  }): Promise<SubtitleAlignmentResult> {
    const apiKey = requireApiKey();
    const { dubbedAudioPath, targetLangCode, expectedText, providerSrtTranscript } = params;
    const audioBuf = await fs.readFile(dubbedAudioPath);
    const filename = path.basename(dubbedAudioPath);

    // 1. Prefer Forced Alignment when we know the exact translated text spoken in the audio
    if (expectedText && expectedText.trim().length > 0) {
      try {
        const alignForm = new FormData();
        alignForm.append('file', new Blob([audioBuf]), filename);
        alignForm.append('text', expectedText.trim());

        const alignRes = await fetch(`${ELEVENLABS_BASE_URL}/forced-alignment`, {
          method: 'POST',
          headers: { 'xi-api-key': apiKey },
          body: alignForm,
        });

        if (alignRes.ok) {
          const alignData = (await alignRes.json()) as {
            words?: Array<{ text?: string; start?: number; end?: number; loss?: number }>;
            loss?: number;
          };
          const alignedWords = (alignData.words ?? [])
            .filter(
              (w) =>
                typeof w.text === 'string' &&
                w.text.trim().length > 0 &&
                typeof w.start === 'number' &&
                typeof w.end === 'number' &&
                w.end >= w.start,
            )
            .map((w) => ({
              text: w.text!.trim(),
              start: w.start!,
              end: w.end!,
            }));

          if (alignedWords.length > 0 && (alignData.loss === undefined || alignData.loss < 4.5)) {
            return {
              words: alignedWords,
              alignmentMethod: 'forced_alignment',
            };
          }
        }
      } catch {
        // Fall through to timestamped Speech-to-Text on the actual dubbed audio
      }
    }

    // 2. Fallback to timestamped Speech-to-Text (Scribe v2) directly on the final dubbed audio
    const sttForm = new FormData();
    sttForm.append('file', new Blob([audioBuf]), filename);
    sttForm.append('model_id', 'scribe_v2');
    sttForm.append('timestamps_granularity', 'word');
    if (targetLangCode) {
      sttForm.append('language_code', targetLangCode);
    }

    const sttRes = await fetch(`${ELEVENLABS_BASE_URL}/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: sttForm,
    });

    if (sttRes.ok) {
      const sttData = (await sttRes.json()) as {
        words?: Array<{ text?: string; type?: string; start?: number; end?: number }>;
      };
      const words: WordTimestamp[] = (sttData.words ?? [])
        .filter(
          (w) =>
            w.type !== 'spacing' &&
            typeof w.text === 'string' &&
            w.text.trim().length > 0 &&
            typeof w.start === 'number' &&
            typeof w.end === 'number',
        )
        .map((w) => ({
          text: w.text!.trim(),
          start: w.start!,
          end: w.end!,
        }));

      if (words.length > 0) {
        return {
          words,
          alignmentMethod: 'speech_recognition',
        };
      }
    }

    // 3. Fallback to Fish Audio ASR if Fish Audio is configured and ElevenLabs auth failed
    const cfg = getConfig();
    if (!sttRes.ok && cfg.voiceCloneFormat === 'fish_audio' && cfg.voiceCloneApiKey) {
      try {
        const fishAsr = await transcribeWithFishAudioAsr(dubbedAudioPath, targetLangCode);
        const fallbackWords: WordTimestamp[] =
          fishAsr.words.length > 0
            ? fishAsr.words
            : fishAsr.segments.map((s) => ({
                text: s.text,
                start: s.start,
                end: s.end,
              }));
        if (fallbackWords.length > 0) {
          return {
            words: fallbackWords,
            alignmentMethod: 'speech_recognition',
          };
        }
      } catch {
        // Fall through to report primary ElevenLabs error
      }
    }

    // 4. Last resort if provider already supplied an exact SRT transcript from native dubbing
    if (providerSrtTranscript && providerSrtTranscript.trim().length > 0) {
      return {
        providerSrt: providerSrtTranscript,
        alignmentMethod: 'provider_transcript',
      };
    }

    const detail = !sttRes.ok ? await parseErrorDetail(sttRes) : 'No timestamped words returned.';
    throw new Error(`Subtitle alignment/transcription failed: ${detail}`);
  }
}
