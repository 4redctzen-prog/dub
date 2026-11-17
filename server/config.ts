import 'dotenv/config';
import path from 'node:path';

export type VoiceCloneApiFormat = 'multipart' | 'json_base64' | 'cartesia' | 'fish_audio';

export interface AppConfig {
  port: number;
  llmApiUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmRequestFormat: 'openai' | 'anthropic' | 'gemini' | 'auto';
  voiceProvider: string;
  elevenLabsApiKey: string;
  geminiApiKey: string;
  voiceCloneApiUrl: string;
  voiceCloneApiKey: string;
  voiceCloneModel: string;
  voiceCloneFormat: VoiceCloneApiFormat;
  voiceCloneAuthHeader: string;
  voiceCloneAuthPrefix: string;
  sttApiUrl: string;
  sttApiKey: string;
  sttModel: string;
  maxUploadMb: number;
  maxDurationSec: number;
  tempTtlMs: number;
  storageRoot: string;
  tempDir: string;
  jobsDir: string;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseLlmFormat(raw: string | undefined): 'openai' | 'anthropic' | 'gemini' | 'auto' {
  const val = (raw ?? '').trim().toLowerCase();
  if (val === 'openai' || val === 'anthropic' || val === 'gemini') {
    return val;
  }
  return 'auto';
}

function parseVoiceCloneFormat(raw: string | undefined, url: string): VoiceCloneApiFormat {
  const lowerUrl = url.toLowerCase();
  if (lowerUrl.includes('fish.audio')) return 'fish_audio';
  if (lowerUrl.includes('cartesia.ai')) return 'cartesia';

  const val = (raw ?? '').trim().toLowerCase();
  if (val === 'multipart' || val === 'json_base64' || val === 'cartesia' || val === 'fish_audio') {
    return val;
  }
  if (val === 'fish' || val === 'fishaudio' || val === 'fish-audio') {
    return 'fish_audio';
  }
  return 'multipart';
}

export function getConfig(): AppConfig {
  const storageRoot = path.resolve(process.cwd(), 'storage');
  const voiceCloneApiUrl = (process.env.VOICE_CLONE_API_URL ?? '').trim();
  const voiceCloneFormat = parseVoiceCloneFormat(process.env.VOICE_CLONE_FORMAT, voiceCloneApiUrl);
  const rawVoiceCloneModel = (process.env.VOICE_CLONE_MODEL ?? '').trim();
  const isStaleCartesiaModel =
    voiceCloneFormat === 'fish_audio' && /^sonic[-_]/i.test(rawVoiceCloneModel);
  const voiceCloneModel =
    rawVoiceCloneModel && !isStaleCartesiaModel
      ? rawVoiceCloneModel
      : voiceCloneFormat === 'fish_audio'
        ? 's2.1-pro-free'
        : '';

  const rawGeminiKey = (process.env.GEMINI_API_KEY ?? '').trim();
  const geminiApiKey = rawGeminiKey === 'MY_GEMINI_API_KEY' ? '' : rawGeminiKey;

  return {
    port: parsePositiveInt(process.env.PORT, 3000),
    llmApiUrl: (process.env.LLM_API_URL ?? '').trim(),
    llmApiKey: (process.env.LLM_API_KEY ?? '').trim(),
    llmModel: (process.env.LLM_MODEL ?? '').trim(),
    llmRequestFormat: parseLlmFormat(process.env.LLM_REQUEST_FORMAT),
    voiceProvider: (process.env.VOICE_PROVIDER ?? 'elevenlabs').trim().toLowerCase(),
    elevenLabsApiKey: (process.env.ELEVENLABS_API_KEY ?? '').trim(),
    geminiApiKey,
    voiceCloneApiUrl,
    voiceCloneApiKey: (process.env.VOICE_CLONE_API_KEY ?? '').trim(),
    voiceCloneModel,
    voiceCloneFormat,
    voiceCloneAuthHeader: (process.env.VOICE_CLONE_AUTH_HEADER ?? 'Authorization').trim(),
    voiceCloneAuthPrefix:
      process.env.VOICE_CLONE_AUTH_PREFIX !== undefined
        ? process.env.VOICE_CLONE_AUTH_PREFIX.trim()
        : 'Bearer',
    sttApiUrl: (process.env.STT_API_URL ?? '').trim(),
    sttApiKey: (process.env.STT_API_KEY ?? '').trim(),
    sttModel: (process.env.STT_MODEL ?? 'whisper-1').trim(),
    maxUploadMb: parsePositiveInt(process.env.MAX_UPLOAD_MB, 50),
    maxDurationSec: parsePositiveInt(process.env.MAX_DURATION_SEC, 600),
    tempTtlMs: parsePositiveInt(process.env.TEMP_TTL_MS, 3600000),
    storageRoot,
    tempDir: path.join(storageRoot, 'temp'),
    jobsDir: path.join(storageRoot, 'jobs'),
  };
}

export function getCredentialDiagnostics() {
  const cfg = getConfig();
  const llmMissingFields: string[] = [];
  if (!cfg.llmApiUrl) llmMissingFields.push('LLM_API_URL');
  if (!cfg.llmApiKey) llmMissingFields.push('LLM_API_KEY');
  if (!cfg.llmModel) llmMissingFields.push('LLM_MODEL');

  const voiceProviderMissingFields: string[] = [];
  if (cfg.voiceProvider === 'elevenlabs') {
    if (!cfg.elevenLabsApiKey) {
      voiceProviderMissingFields.push('ELEVENLABS_API_KEY');
    }
  } else if (cfg.voiceProvider === 'external' || cfg.voiceProvider === 'custom') {
    if (!cfg.voiceCloneApiUrl) voiceProviderMissingFields.push('VOICE_CLONE_API_URL');
    const hasFishAsr = cfg.voiceCloneFormat === 'fish_audio' && Boolean(cfg.voiceCloneApiKey);
    if (!cfg.elevenLabsApiKey && !cfg.sttApiUrl && !hasFishAsr) {
      voiceProviderMissingFields.push('STT_API_URL (or ELEVENLABS_API_KEY for STT/SRT)');
    }
  } else if (cfg.voiceProvider === 'gemini' || cfg.voiceProvider === 'gemini-only' || cfg.voiceProvider === 'gemini_only') {
    if (!cfg.geminiApiKey) {
      voiceProviderMissingFields.push('GEMINI_API_KEY');
    }
  } else {
    voiceProviderMissingFields.push(`Unsupported VOICE_PROVIDER (${cfg.voiceProvider})`);
  }

  const isGeminiProvider =
    cfg.voiceProvider === 'gemini' ||
    cfg.voiceProvider === 'gemini-only' ||
    cfg.voiceProvider === 'gemini_only';

  return {
    llmConfigured: llmMissingFields.length === 0,
    llmMissingFields,
    llmModelLabel: cfg.llmModel || (isGeminiProvider && cfg.geminiApiKey ? 'gemini-4-hydrogen' : 'Not configured'),
    voiceProvider: cfg.voiceProvider,
    voiceProviderConfigured: voiceProviderMissingFields.length === 0,
    voiceProviderMissingFields,
    voiceCloneOverrideConfigured: !isGeminiProvider && Boolean(cfg.voiceCloneApiUrl),
    voiceCloneFormatLabel: isGeminiProvider
      ? 'Built-in Gemini TTS (Style-Matched)'
      : cfg.voiceCloneApiUrl
        ? `${cfg.voiceCloneFormat}${cfg.voiceCloneModel ? ` (${cfg.voiceCloneModel})` : ''}`
        : 'ElevenLabs',
    geminiConfigured: Boolean(cfg.geminiApiKey),
    maxUploadMb: cfg.maxUploadMb,
    maxDurationSec: cfg.maxDurationSec,
  };
}
