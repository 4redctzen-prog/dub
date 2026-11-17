import type {
  DubbingSettings,
  LanguageTranslationResult,
  SourceTranscription,
  SupportedLanguage,
  WordTimestamp,
} from '../types.ts';

export interface DubbingSynthesisResult {
  dubbedAudioPath: string;
  methodUsed:
    | 'dubbing_studio_external_llm'
    | 'audio_conditioned_clone_llm'
    | 'external_voice_clone_api'
    | 'native_provider_dubbing'
    | 'gemini_style_matched_tts';
  providerLimitationNotice?: string;
  providerSrtTranscript?: string;
}

export interface SubtitleAlignmentResult {
  words?: WordTimestamp[];
  providerSrt?: string;
  alignmentMethod: 'forced_alignment' | 'speech_recognition' | 'provider_transcript';
}

export interface VoiceDubbingProvider {
  readonly id: string;
  readonly name: string;

  getSupportedLanguages(): SupportedLanguage[];

  transcribeOriginalAudio(
    audioPath: string,
    sourceLangHint: string,
  ): Promise<SourceTranscription>;

  dubWithExternalTranslation(params: {
    originalAudioPath: string;
    sourceLang: string;
    sourceTranscriptText?: string;
    targetLang: string;
    translation: LanguageTranslationResult;
    settings: DubbingSettings;
    originalDurationSec: number;
    workDir: string;
    onProgress?: (stageLabel: string, progressPct?: number | null) => void;
  }): Promise<DubbingSynthesisResult>;

  generateTimestampsForSubtitles(params: {
    dubbedAudioPath: string;
    targetLangCode: string;
    expectedText?: string;
    providerSrtTranscript?: string;
  }): Promise<SubtitleAlignmentResult>;
}
