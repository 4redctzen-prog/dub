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

export interface SupportedLanguage {
  code: string;
  name: string;
  nativeName: string;
  filenameSlug: string;
}

export interface SystemCapabilities {
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

export interface ClientLanguageTask {
  languageCode: string;
  languageName: string;
  nativeName: string;
  status: LanguageTaskStatus;
  stageLabel: string;
  providerProgress: number | null;
  dubbingMethodUsed?:
    | 'dubbing_studio_external_llm'
    | 'audio_conditioned_clone_llm'
    | 'external_voice_clone_api'
    | 'native_provider_dubbing'
    | 'gemini_style_matched_tts';
  providerLimitationNotice?: string;
  translatedScript?: string;
  llmModel?: string;
  durationSec?: number;
  waveformPeaks?: number[];
  audioPreviewUrl?: string;
  mp3DownloadUrl?: string;
  wavDownloadUrl?: string;
  srtDownloadUrl?: string;
  mp3Filename?: string;
  wavFilename?: string;
  subtitle: {
    status: 'pending' | 'generating' | 'completed' | 'failed';
    srtFilename?: string;
    srtPreview?: string;
    cueCount?: number;
    alignmentMethod?: 'forced_alignment' | 'speech_recognition' | 'provider_transcript';
    error?: string;
  };
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface ClientDubbingJob {
  id: string;
  createdAt: number;
  updatedAt: number;
  stage: JobStage;
  stageLabel: string;
  voiceCloneAuthorized: boolean;
  sourceLanguageInput: string;
  detectedSourceLanguage?: string;
  settings: DubbingSettings;
  originalAudio: AudioMetadata;
  originalAudioUrl: string;
  sourceTranscription?: {
    languageCode: string;
    text: string;
    segmentCount: number;
  };
  providerLimitationNotice?: string;
  error?: string;
  languages: ClientLanguageTask[];
}
