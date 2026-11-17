import { getConfig } from '../config.ts';
import type { DubbingWorkflowMode } from '../types.ts';
import { ElevenLabsProvider } from './elevenlabsProvider.ts';
import { ExternalVoiceProvider } from './externalProvider.ts';
import { GeminiVoiceProvider } from './geminiProvider.ts';
import type { VoiceDubbingProvider } from './voiceProvider.ts';

const elevenLabsProvider = new ElevenLabsProvider();
const externalVoiceProvider = new ExternalVoiceProvider();
const geminiVoiceProvider = new GeminiVoiceProvider();

export function getVoiceProvider(workflowMode?: DubbingWorkflowMode): VoiceDubbingProvider {
  const { voiceProvider } = getConfig();
  if (
    workflowMode === 'gemini_only' ||
    voiceProvider === 'gemini' ||
    voiceProvider === 'gemini-only' ||
    voiceProvider === 'gemini_only'
  ) {
    return geminiVoiceProvider;
  }
  if (voiceProvider === 'elevenlabs') {
    return elevenLabsProvider;
  }
  if (voiceProvider === 'external' || voiceProvider === 'custom') {
    return externalVoiceProvider;
  }
  throw new Error(
    `Unsupported VOICE_PROVIDER "${voiceProvider}". Supported values: elevenlabs, external, gemini.`,
  );
}
