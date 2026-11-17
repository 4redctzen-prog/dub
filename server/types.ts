export type JobStage =
  | 'uploading_audio'
  | 'processing_original'
  | 'translating'
  | 'generating_voice'
  | 'processing_final_audio'
  | 'generating_subtitles'
  | 'completed'
  | 'failed';

export type LanguageTaskStatus =
  | 'pending'
  | 'translating'
  | 'generating_voice'
  | 'processing_final_audio'
  | 'generating_subtitles'
  | 'completed'
  | 'failed';

export type DubbingWorkflowMode = 'auto' | 'clone_tts' | 'native_dubbing' | 'gemini_only';

export interface DubbingSettings {
  preserveSpeakerIdentity: boolean;
  preserveNarrationStyle: boolean;
  preserveEmotionalExpression: boolean;
  preserveRhythmAndPacing: boolean;
  preserveVocalCharacteristics: boolean;
  workflowMode: DubbingWorkflowMode;
}

export interface AudioMetadata {
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  durationSec: number;
  sampleRate: number;
  channels: number;
  codec: string;
  waveformPeaks: number[];
}

export interface WordTimestamp {
  text: string;
  start: number;
  end: number;
  speakerId?: string;
}

export interface TranscriptSegment {
  id: string;
  speakerId: string;
  start: number;
  end: number;
  text: string;
}

export interface SourceTranscription {
  languageCode: string;
  text: string;
  segments: TranscriptSegment[];
  words: WordTimestamp[];
}

export interface TranslatedSegment {
  id: string;
  start: number;
  end: number;
  sourceText: string;
  translatedText: string;
}

export interface LanguageTranslationResult {
  targetLanguageCode: string;
  targetLanguageName: string;
  fullTranslatedText: string;
  segments: TranslatedSegment[];
  llmModel: string;
}

export interface SubtitleResult {
  status: 'pending' | 'generating' | 'completed' | 'failed';
  srtPath?: string;
  srtFilename?: string;
  srtPreview?: string;
  cueCount?: number;
  alignmentMethod?: 'forced_alignment' | 'speech_recognition' | 'provider_transcript';
  error?: string;
}

export interface LanguageTask {
  languageCode: string;
  languageName: string;
  nativeName: string;
  status: LanguageTaskStatus;
  stageLabel: string;
  providerProgress?: number | null;
  dubbingMethodUsed?:
    | 'dubbing_studio_external_llm'
    | 'audio_conditioned_clone_llm'
    | 'external_voice_clone_api'
    | 'native_provider_dubbing'
    | 'gemini_style_matched_tts';
  providerLimitationNotice?: string;
  translation?: LanguageTranslationResult;
  mp3Path?: string;
  wavPath?: string;
  mp3Filename?: string;
  wavFilename?: string;
  durationSec?: number;
  waveformPeaks?: number[];
  subtitle: SubtitleResult;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface DubbingJob {
  id: string;
  createdAt: number;
  updatedAt: number;
  stage: JobStage;
  stageLabel: string;
  voiceCloneAuthorized: boolean;
  sourceLanguageInput: string; // 'auto' or ISO code
  detectedSourceLanguage?: string;
  settings: DubbingSettings;
  originalAudio: AudioMetadata;
  originalAudioPath: string;
  sourceTranscription?: SourceTranscription;
  languages: LanguageTask[];
  providerLimitationNotice?: string;
  error?: string;
}

export interface SupportedLanguage {
  code: string;
  name: string;
  nativeName: string;
  filenameSlug: string;
}

export interface SystemCapabilitiesResponse {
  llmConfigured: boolean;
  llmMissingFields: string[];
  llmModelLabel: string;
  voiceProvider: string;
  voiceProviderConfigured: boolean;
  voiceProviderMissingFields: string[];
  voiceCloneOverrideConfigured: boolean;
  voiceCloneFormatLabel: string;
  geminiConfigured: boolean;
  maxUploadMb: number;
  maxDurationSec: number;
  supportedLanguages: SupportedLanguage[];
}
