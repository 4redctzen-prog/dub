import { useRef, useState } from 'react';
import { AlertTriangle, Check, FileAudio, Upload } from 'lucide-react';
import type {
  AudioMetadata,
  DubbingSettings,
  DubbingWorkflowMode,
  SystemCapabilities,
} from '../types/dubbing';
import { formatDuration, formatFileSize } from '../utils/formatters';
import { AudioWaveformPlayer } from './AudioWaveformPlayer';

interface StudioConfigPanelProps {
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  selectedFile: File | null;
  localPreviewUrl: string | null;
  audioMeta: AudioMetadata | null;
  isInspectingAudio: boolean;
  inspectError: string | null;
  capabilities: SystemCapabilities | null;
  sourceLanguage: string;
  targetLanguages: string[];
  settings: DubbingSettings;
  voiceCloneAuthorized: boolean;
  isSubmitting: boolean;
  isLocked: boolean;
  onFileSelected: (file: File) => void;
  onClearFile: () => void;
  onSourceLanguageChange: (lang: string) => void;
  onToggleTargetLanguage: (code: string) => void;
  onClearTargetLanguages: () => void;
  onSettingsChange: (next: DubbingSettings) => void;
  onAuthorizationChange: (authorized: boolean) => void;
  onGenerate: () => void;
}

const PRESERVATION_OPTIONS: Array<{
  key: keyof Omit<DubbingSettings, 'workflowMode'>;
  label: string;
  hint: string;
}> = [
  {
    key: 'preserveSpeakerIdentity',
    label: 'Preserve original speaker identity',
    hint: 'Keep recognizable vocal timbre and speaker identity across languages',
  },
  {
    key: 'preserveNarrationStyle',
    label: 'Preserve original narration style',
    hint: 'Maintain storytelling cadence, emphasis, and rhetorical delivery',
  },
  {
    key: 'preserveEmotionalExpression',
    label: 'Preserve emotional expression',
    hint: 'Retain warmth, urgency, or subtle mood shifts from the source recording',
  },
  {
    key: 'preserveRhythmAndPacing',
    label: 'Preserve speaking rhythm and pacing',
    hint: 'Align translated segment timing and breathing pauses with the original track',
  },
  {
    key: 'preserveVocalCharacteristics',
    label: 'Preserve original vocal characteristics',
    hint: 'Retain natural texture and acoustic clarity without robotic flattening',
  },
];

export function StudioConfigPanel({
  fileInputRef,
  selectedFile,
  localPreviewUrl,
  audioMeta,
  isInspectingAudio,
  inspectError,
  capabilities,
  sourceLanguage,
  targetLanguages,
  settings,
  voiceCloneAuthorized,
  isSubmitting,
  isLocked,
  onFileSelected,
  onClearFile,
  onSourceLanguageChange,
  onToggleTargetLanguage,
  onClearTargetLanguages,
  onSettingsChange,
  onAuthorizationChange,
  onGenerate,
}: StudioConfigPanelProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [sourceMode, setSourceMode] = useState<'auto' | 'manual'>(
    sourceLanguage === 'auto' ? 'auto' : 'manual',
  );
  const dropZoneRef = useRef<HTMLDivElement | null>(null);

  const supportedLanguages = capabilities?.supportedLanguages ?? [];
  const isGeminiMode =
    settings.workflowMode === 'gemini_only' ||
    Boolean(capabilities?.voiceProvider?.startsWith('gemini'));
  const llmMissing =
    capabilities &&
    !capabilities.llmConfigured &&
    settings.workflowMode !== 'native_dubbing' &&
    !isGeminiMode;
  const voiceMissing =
    capabilities &&
    (isGeminiMode ? !capabilities.geminiConfigured : !capabilities.voiceProviderConfigured);

  const canGenerate =
    Boolean(selectedFile) &&
    !isInspectingAudio &&
    !inspectError &&
    targetLanguages.length > 0 &&
    voiceCloneAuthorized &&
    !isSubmitting &&
    !isLocked &&
    !llmMissing &&
    !voiceMissing;

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (isLocked) return;
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) onFileSelected(dropped);
  };

  return (
    <div className="space-y-8">
      {/* Configuration Diagnostics Banner (Only when backend env credentials are missing) */}
      {(llmMissing || voiceMissing) && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-4 text-sm text-amber-100">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#E5A93C]" />
            <div className="space-y-1">
              <p className="font-medium text-[#F8DFAA]">Backend API credentials required</p>
              {llmMissing && (
                <p className="text-xs text-amber-200/80">
                  External LLM missing: {capabilities?.llmMissingFields.join(', ')}. Set these in your server environment.
                </p>
              )}
              {voiceMissing && (
                <p className="text-xs text-amber-200/80">
                  {isGeminiMode
                    ? 'GEMINI_API_KEY is missing in Settings → Secrets for Built-in Gemini Only mode.'
                    : `Voice Provider (${capabilities?.voiceProvider}) missing: ${capabilities?.voiceProviderMissingFields.join(', ')}.`}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* A. Upload Audio */}
      <section id="upload-section" className="rounded-xl border border-white/[0.08] bg-[#12151C] p-6">
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <h2 className="font-display text-base font-semibold text-[#F1F3F5]">
            1. Original Voice Recording
          </h2>
          <span className="text-xs text-[#8892A0] tabular-nums">
            MP3, WAV, M4A · Max {capabilities?.maxUploadMb ?? 50} MB
          </span>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFileSelected(f);
            e.target.value = '';
          }}
        />

        {!selectedFile ? (
          <div
            ref={dropZoneRef}
            onDragOver={(e) => {
              e.preventDefault();
              if (!isLocked) setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            onClick={() => !isLocked && fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !isLocked) {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            className={`flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-6 py-10 text-center transition-colors ${
              isDragging
                ? 'border-[#E5A93C] bg-[#E5A93C]/[0.06]'
                : 'border-white/[0.16] bg-[#0E1117] hover:border-white/[0.28] hover:bg-[#141820]'
            }`}
          >
            <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-lg border border-white/[0.08] bg-[#161B24] text-[#E5A93C]">
              <Upload className="h-5 w-5" />
            </div>
            <p className="text-sm font-medium text-[#F1F3F5]">
              Drop an audio recording here, or click to browse
            </p>
            <p className="mt-1 text-xs text-[#8892A0]">
              Supports MP3, WAV, and M4A up to {Math.round((capabilities?.maxDurationSec ?? 600) / 60)} minutes
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3 min-w-0">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-[#161B24] text-[#E5A93C]">
                  <FileAudio className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-[#F1F3F5]">
                    {selectedFile.name}
                  </p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-xs text-[#8892A0]">
                    <span>{formatFileSize(audioMeta?.sizeBytes ?? selectedFile.size)}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {isInspectingAudio
                        ? 'Analyzing...'
                        : audioMeta
                          ? formatDuration(audioMeta.durationSec)
                          : '--:--'}
                    </span>
                    {audioMeta?.sampleRate && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{(audioMeta.sampleRate / 1000).toFixed(1)} kHz</span>
                      </>
                    )}
                    {audioMeta?.codec && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="uppercase">{audioMeta.codec}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {!isLocked && (
                <button
                  type="button"
                  onClick={onClearFile}
                  className="min-h-[36px] shrink-0 rounded-md border border-white/[0.12] px-3 py-1.5 text-xs font-medium text-[#C4CBD4] transition-colors hover:bg-white/[0.06] hover:text-[#F1F3F5] whitespace-nowrap"
                >
                  Replace
                </button>
              )}
            </div>

            {localPreviewUrl && (
              <AudioWaveformPlayer
                src={localPreviewUrl}
                peaks={audioMeta?.waveformPeaks ?? []}
                durationSec={audioMeta?.durationSec}
                compact
              />
            )}

            {inspectError && (
              <p className="text-xs font-medium text-rose-400">{inspectError}</p>
            )}
          </div>
        )}
      </section>

      {/* B. Source Language & C. Target Languages */}
      <section id="languages-section" className="rounded-xl border border-white/[0.08] bg-[#12151C] p-6 space-y-6">
        {/* Source Language */}
        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-base font-semibold text-[#F1F3F5]">
              2. Source Language
            </h2>
            <div className="flex items-center gap-1 rounded-lg border border-white/[0.08] bg-[#0B0D11] p-1">
              <button
                type="button"
                disabled={isLocked}
                onClick={() => {
                  setSourceMode('auto');
                  onSourceLanguageChange('auto');
                }}
                className={`min-h-[32px] rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  sourceMode === 'auto'
                    ? 'bg-[#1D222D] text-[#F1F3F5]'
                    : 'text-[#8892A0] hover:text-[#F1F3F5]'
                }`}
              >
                Auto-detect
              </button>
              <button
                type="button"
                disabled={isLocked}
                onClick={() => {
                  setSourceMode('manual');
                  if (sourceLanguage === 'auto' && supportedLanguages.length > 0) {
                    onSourceLanguageChange(supportedLanguages[0].code);
                  }
                }}
                className={`min-h-[32px] rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  sourceMode === 'manual'
                    ? 'bg-[#1D222D] text-[#F1F3F5]'
                    : 'text-[#8892A0] hover:text-[#F1F3F5]'
                }`}
              >
                Manual
              </button>
            </div>
          </div>

          {sourceMode === 'manual' ? (
            <select
              value={sourceLanguage === 'auto' ? 'en' : sourceLanguage}
              disabled={isLocked}
              onChange={(e) => onSourceLanguageChange(e.target.value)}
              aria-label="Source spoken language"
              className="w-full min-h-[42px] rounded-lg border border-white/[0.12] bg-[#0B0D11] px-3.5 py-2 text-sm text-[#F1F3F5] focus:border-[#E5A93C] focus:outline-none disabled:opacity-60"
            >
              {supportedLanguages.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.name} ({lang.nativeName})
                </option>
              ))}
            </select>
          ) : (
            <p className="text-xs text-[#8892A0]">
              Spoken language will be detected automatically from your original recording.
            </p>
          )}
        </div>

        <div className="border-t border-white/[0.06]" />

        {/* Target Languages */}
        <div>
          <div className="mb-3 flex items-baseline justify-between gap-4">
            <h2 className="font-display text-base font-semibold text-[#F1F3F5]">
              3. Target Languages
            </h2>
            <div className="flex items-center gap-3 text-xs">
              <span className="font-mono text-[#9BA3B0]">
                {targetLanguages.length} selected
              </span>
              {targetLanguages.length > 0 && !isLocked && (
                <button
                  type="button"
                  onClick={onClearTargetLanguages}
                  className="text-[#8892A0] hover:text-[#F1F3F5] transition-colors whitespace-nowrap"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {supportedLanguages.map((lang) => {
              const selected = targetLanguages.includes(lang.code);
              return (
                <button
                  key={lang.code}
                  type="button"
                  disabled={isLocked}
                  onClick={() => onToggleTargetLanguage(lang.code)}
                  className={`flex min-h-[44px] items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-[#E5A93C] disabled:opacity-60 ${
                    selected
                      ? 'border-[#E5A93C]/70 bg-[#E5A93C]/[0.1] text-[#F1F3F5]'
                      : 'border-white/[0.08] bg-[#0E1117] text-[#C4CBD4] hover:border-white/[0.18] hover:bg-[#151922]'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium">{lang.name}</div>
                    <div className="truncate text-[11px] text-[#8892A0]">{lang.nativeName}</div>
                  </div>
                  {selected && <Check className="h-3.5 w-3.5 shrink-0 text-[#E5A93C]" />}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* D. Dubbing Settings */}
      <section id="settings-section" className="rounded-xl border border-white/[0.08] bg-[#12151C] p-6 space-y-5">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-display text-base font-semibold text-[#F1F3F5]">
            4. Voice & Delivery Preservation
          </h2>
          <span className="text-xs text-[#8892A0]">
            {isGeminiMode
              ? 'Built-in Gemini TTS'
              : capabilities?.voiceCloneOverrideConfigured
                ? `External Cloner (${capabilities.voiceCloneFormatLabel})`
                : capabilities?.voiceProvider === 'elevenlabs'
                  ? 'ElevenLabs'
                  : capabilities?.voiceProvider ?? 'Provider'}
          </span>
        </div>

        <div className="space-y-3">
          {PRESERVATION_OPTIONS.map((opt) => {
            const checked = settings[opt.key];
            return (
              <label
                key={opt.key}
                className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.02]"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={isLocked}
                  onChange={(e) =>
                    onSettingsChange({
                      ...settings,
                      [opt.key]: e.target.checked,
                    })
                  }
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-white/25 bg-[#0B0D11] accent-[#E5A93C]"
                />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-[#E6E9EE]">{opt.label}</div>
                  <div className="text-xs text-[#8892A0]">{opt.hint}</div>
                </div>
              </label>
            );
          })}
        </div>

        <div className="border-t border-white/[0.06] pt-4">
          <label className="mb-2 block text-xs font-medium text-[#9BA3B0]">
            Dubbing Orchestration Mode
          </label>
          <select
            value={settings.workflowMode}
            disabled={isLocked}
            onChange={(e) =>
              onSettingsChange({
                ...settings,
                workflowMode: e.target.value as DubbingWorkflowMode,
              })
            }
            className="w-full min-h-[42px] rounded-lg border border-white/[0.12] bg-[#0B0D11] px-3.5 py-2 text-sm text-[#F1F3F5] focus:border-[#E5A93C] focus:outline-none disabled:opacity-60"
          >
            <option value="auto">
              External LLM + Audio-Conditioned Dubbing (Recommended)
            </option>
            <option value="gemini_only">
              Built-in Gemini Only (Style-Matched TTS, No External Voice API)
            </option>
            <option value="clone_tts">
              External LLM + Speaker Voice Cloning Synthesis
            </option>
            <option value="native_dubbing">
              Native Provider Audio-to-Audio Dubbing (Uses Provider Translator)
            </option>
          </select>
          <p className="mt-1.5 text-xs text-[#8892A0]">
            {settings.workflowMode === 'gemini_only'
              ? 'Uses built-in Gemini for transcription, style-matched multilingual TTS, and SRT sync without ElevenLabs or Fish Audio (matches vocal register and delivery style rather than exact zero-shot cloning).'
              : settings.workflowMode === 'native_dubbing'
                ? 'Uses ElevenLabs Dubbing API end-to-end without calling your external LLM.'
                : 'Uses your configured external LLM for translation & pacing, and preserves speaker voice from the uploaded audio.'}
          </p>
        </div>

        <div className="border-t border-white/[0.06] pt-4">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={voiceCloneAuthorized}
              disabled={isLocked}
              onChange={(e) => onAuthorizationChange(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-white/25 bg-[#0B0D11] accent-[#E5A93C]"
            />
            <span className="text-xs leading-relaxed text-[#C4CBD4]">
              I confirm that I have explicit authorization from the speaker to clone and dub the uploaded voice recording.
            </span>
          </label>
        </div>

        {/* E. Generate Button */}
        <button
          type="button"
          disabled={!canGenerate}
          onClick={onGenerate}
          className="w-full min-h-[48px] rounded-lg bg-[#E5A93C] px-6 py-3 font-display text-sm font-semibold tracking-wide text-[#0B0D11] transition-colors hover:bg-[#EEB854] disabled:cursor-not-allowed disabled:bg-white/[0.08] disabled:text-[#667080] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#E5A93C]"
        >
          {isSubmitting ? 'UPLOADING AUDIO...' : 'GENERATE DUBBING'}
        </button>
      </section>
    </div>
  );
}
