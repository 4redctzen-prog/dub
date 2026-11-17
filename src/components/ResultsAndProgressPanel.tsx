import { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Download,
  FileText,
  FolderArchive,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import type {
  ClientDubbingJob,
  ClientLanguageTask,
  JobStage,
  SupportedLanguage,
  SystemCapabilities,
} from '../types/dubbing';
import { formatDuration } from '../utils/formatters';
import { AudioWaveformPlayer } from './AudioWaveformPlayer';

interface ResultsAndProgressPanelProps {
  job: ClientDubbingJob | null;
  isUploading: boolean;
  uploadError: string | null;
  capabilities: SystemCapabilities | null;
  onRetryJob: (languageCode?: string) => void;
  onRetrySubtitles: (languageCode: string) => void;
  onAddLanguages: (codes: string[]) => void;
  onStartNewProject: () => void;
  onDeleteProject: () => void;
}

const PIPELINE_STEPS: Array<{ stage: JobStage; label: string }> = [
  { stage: 'uploading_audio', label: 'Uploading audio' },
  { stage: 'processing_original', label: 'Processing original recording' },
  { stage: 'translating', label: 'Translating' },
  { stage: 'generating_voice', label: 'Generating cloned voice' },
  { stage: 'processing_final_audio', label: 'Processing final audio' },
  { stage: 'generating_subtitles', label: 'Generating synchronized SRT' },
  { stage: 'completed', label: 'Completed' },
];

function getStageIndex(stage: JobStage): number {
  const idx = PIPELINE_STEPS.findIndex((s) => s.stage === stage);
  return idx === -1 ? 0 : idx;
}

function LanguageResultCard({
  lang,
  onRetryLanguage,
  onRetrySubtitles,
}: {
  lang: ClientLanguageTask;
  onRetryLanguage: (code: string) => void;
  onRetrySubtitles: (code: string) => void;
}) {
  const [showTranscript, setShowTranscript] = useState(false);

  const isCompleted = lang.status === 'completed';
  const isFailed = lang.status === 'failed';
  const isRunning = !isCompleted && !isFailed;

  const methodDescription =
    lang.dubbingMethodUsed === 'dubbing_studio_external_llm'
      ? 'Dubbing Studio + External LLM'
      : lang.dubbingMethodUsed === 'external_voice_clone_api'
        ? 'External Voice Cloning API + External LLM'
        : lang.dubbingMethodUsed === 'audio_conditioned_clone_llm'
          ? 'Voice Clone + External LLM'
          : lang.dubbingMethodUsed === 'gemini_style_matched_tts'
            ? 'Built-in Gemini TTS (Style-Matched)'
            : lang.dubbingMethodUsed === 'native_provider_dubbing'
              ? 'Native Provider Dubbing'
              : undefined;

  return (
    <div className="rounded-xl border border-white/[0.08] bg-[#12151C] p-5 space-y-4">
      {/* Header Row */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-baseline gap-2">
            <h3 className="font-display text-base font-semibold text-[#F1F3F5]">
              {lang.languageName}
            </h3>
            <span className="text-sm text-[#8892A0]">{lang.nativeName}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#8892A0]">
            {isCompleted && (
              <span className="inline-flex items-center gap-1.5 text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>{lang.stageLabel}</span>
              </span>
            )}
            {isFailed && (
              <span className="inline-flex items-center gap-1.5 text-rose-400">
                <AlertCircle className="h-3.5 w-3.5" />
                <span>Failed</span>
              </span>
            )}
            {isRunning && (
              <span className="inline-flex items-center gap-1.5 text-[#E5A93C]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>
                  {lang.stageLabel}
                  {lang.providerProgress !== null ? ` (${lang.providerProgress}%)` : ''}
                </span>
              </span>
            )}
            {lang.durationSec !== undefined && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono text-[#C4CBD4]">{formatDuration(lang.durationSec)}</span>
              </>
            )}
            {methodDescription && (
              <>
                <span aria-hidden="true">·</span>
                <span>{methodDescription}</span>
              </>
            )}
            {lang.llmModel && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono">{lang.llmModel}</span>
              </>
            )}
          </div>
        </div>

        {isFailed && (
          <button
            type="button"
            onClick={() => onRetryLanguage(lang.languageCode)}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-white/[0.14] bg-[#181C24] px-3 py-1.5 text-xs font-medium text-[#F1F3F5] hover:bg-[#1E2430] whitespace-nowrap"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Retry
          </button>
        )}
      </div>

      {lang.error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/[0.08] px-3.5 py-2.5 text-xs text-rose-200">
          {lang.error}
        </div>
      )}

      {lang.providerLimitationNotice && (
        <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-2.5 text-xs text-amber-200/90">
          {lang.providerLimitationNotice}
        </div>
      )}

      {/* Waveform Audio Player */}
      {isCompleted && lang.audioPreviewUrl && (
        <AudioWaveformPlayer
          src={lang.audioPreviewUrl}
          peaks={lang.waveformPeaks ?? []}
          durationSec={lang.durationSec}
        />
      )}

      {/* Independent Download Buttons: MP3, WAV, SRT */}
      {isCompleted && (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="flex flex-wrap items-center gap-2.5">
            {lang.mp3DownloadUrl && (
              <a
                href={lang.mp3DownloadUrl}
                download={lang.mp3Filename}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-white/[0.14] bg-[#171B24] px-3.5 py-2 text-xs font-medium text-[#F1F3F5] transition-colors hover:border-[#E5A93C]/50 hover:bg-[#1E2430] whitespace-nowrap"
              >
                <Download className="h-3.5 w-3.5 text-[#E5A93C]" />
                Download MP3
              </a>
            )}
            {lang.wavDownloadUrl && (
              <a
                href={lang.wavDownloadUrl}
                download={lang.wavFilename}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-white/[0.14] bg-[#171B24] px-3.5 py-2 text-xs font-medium text-[#F1F3F5] transition-colors hover:border-[#E5A93C]/50 hover:bg-[#1E2430] whitespace-nowrap"
              >
                <Download className="h-3.5 w-3.5 text-[#E5A93C]" />
                Download WAV
              </a>
            )}
            {lang.subtitle.status === 'completed' && lang.srtDownloadUrl && (
              <a
                href={lang.srtDownloadUrl}
                download={lang.subtitle.srtFilename}
                className="inline-flex min-h-[40px] items-center gap-2 rounded-lg border border-white/[0.14] bg-[#171B24] px-3.5 py-2 text-xs font-medium text-[#F1F3F5] transition-colors hover:border-[#E5A93C]/50 hover:bg-[#1E2430] whitespace-nowrap"
              >
                <FileText className="h-3.5 w-3.5 text-[#E5A93C]" />
                Download SRT
              </a>
            )}
          </div>

          {(lang.translatedScript || lang.subtitle.srtPreview) && (
            <button
              type="button"
              onClick={() => setShowTranscript((v) => !v)}
              className="inline-flex min-h-[36px] items-center gap-1.5 text-xs font-medium text-[#9BA3B0] hover:text-[#F1F3F5] whitespace-nowrap"
            >
              {showTranscript ? (
                <>
                  <span>Hide Script & SRT</span>
                  <ChevronUp className="h-3.5 w-3.5" />
                </>
              ) : (
                <>
                  <span>Preview Script & SRT</span>
                  <ChevronDown className="h-3.5 w-3.5" />
                </>
              )}
            </button>
          )}
        </div>
      )}

      {/* Independent Subtitle Error Handling */}
      {isCompleted && lang.subtitle.status === 'failed' && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3.5 py-2.5 text-xs text-amber-100">
          <div className="min-w-0 flex-1">
            <span className="font-medium">Subtitle generation failed: </span>
            <span className="text-amber-200/80">{lang.subtitle.error}</span>
          </div>
          <button
            type="button"
            onClick={() => onRetrySubtitles(lang.languageCode)}
            className="inline-flex min-h-[34px] shrink-0 items-center gap-1.5 rounded-md border border-amber-400/40 px-3 py-1 text-xs font-medium text-amber-100 hover:bg-amber-500/15 whitespace-nowrap"
          >
            <RotateCcw className="h-3 w-3" />
            Retry Subtitles
          </button>
        </div>
      )}

      {isCompleted && lang.subtitle.status === 'generating' && (
        <div className="flex items-center gap-2 text-xs text-[#9BA3B0]">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[#E5A93C]" />
          <span>Synchronizing SRT subtitles to dubbed audio...</span>
        </div>
      )}

      {/* Script & SRT Preview Drawer */}
      {showTranscript && (
        <div className="space-y-3 border-t border-white/[0.08] pt-4">
          {lang.translatedScript && (
            <div>
              <div className="mb-1 text-xs font-medium text-[#9BA3B0]">
                Translated Script
              </div>
              <p className="rounded-lg border border-white/[0.06] bg-[#0B0D11] p-3 text-xs leading-relaxed text-[#D8DDE4]">
                {lang.translatedScript}
              </p>
            </div>
          )}

          {lang.subtitle.srtPreview && (
            <div>
              <div className="mb-1 flex items-center justify-between text-xs text-[#9BA3B0]">
                <span className="font-medium">
                  Synchronized Subtitles ({lang.subtitle.srtFilename})
                </span>
                <span className="font-mono">
                  {lang.subtitle.cueCount} cues ·{' '}
                  {lang.subtitle.alignmentMethod === 'forced_alignment'
                    ? 'Forced alignment'
                    : lang.subtitle.alignmentMethod === 'speech_recognition'
                      ? 'Audio STT alignment'
                      : 'Provider transcript'}
                </span>
              </div>
              <pre className="max-h-56 overflow-y-auto rounded-lg border border-white/[0.06] bg-[#0B0D11] p-3 font-mono text-xs leading-relaxed text-[#C4CBD4] whitespace-pre-wrap">
                {lang.subtitle.srtPreview}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ResultsAndProgressPanel({
  job,
  isUploading,
  uploadError,
  capabilities,
  onRetryJob,
  onRetrySubtitles,
  onAddLanguages,
  onStartNewProject,
  onDeleteProject,
}: ResultsAndProgressPanelProps) {
  const [elapsedSec, setElapsedSec] = useState(0);
  const [showAddLanguage, setShowAddLanguage] = useState(false);
  const [extraLangCodes, setExtraLangCodes] = useState<string[]>([]);
  const [showSourceTranscript, setShowSourceTranscript] = useState(false);

  const isRunning =
    isUploading ||
    (job !== null && job.stage !== 'completed' && job.stage !== 'failed');

  useEffect(() => {
    if (!job || !isRunning) return;
    const update = () => {
      setElapsedSec(Math.max(0, Math.floor((Date.now() - job.createdAt) / 1000)));
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [job, isRunning]);

  // Empty / Ready State
  if (!job && !isUploading && !uploadError) {
    return (
      <section
        id="output-section"
        className="rounded-xl border border-white/[0.08] bg-[#12151C] p-6 lg:p-8"
      >
        <h2 className="font-display text-lg font-semibold text-[#F1F3F5]">
          Dubbing Studio Output
        </h2>
        <p className="mt-2 max-w-xl text-sm leading-relaxed text-[#9BA3B0]">
          Upload an original voice recording on the left, select your target languages, and generate voice-preserved dubs with synchronized SRT subtitles.
        </p>

        <div className="mt-8 border-t border-white/[0.08] pt-6">
          <h3 className="text-xs font-medium text-[#8892A0]">Processing Workflow</h3>
          <ol className="mt-4 space-y-4">
            {[
              {
                num: '01.',
                title: 'Upload & Audio Inspection',
                desc: 'Validates MP3, WAV, or M4A streams, extracts duration and waveform peaks.',
              },
              {
                num: '02.',
                title: 'External LLM Translation',
                desc: 'Sends source transcription to your configured LLM for natural, rhythm-aware localization.',
              },
              {
                num: '03.',
                title: 'Voice-Preserved Dubbing',
                desc: 'Uses the original recording to preserve speaker identity, emotion, narration style, and pacing.',
              },
              {
                num: '04.',
                title: 'Synchronized SRT Subtitles',
                desc: 'Aligns timestamps directly against the final dubbed audio and validates UTF-8 SubRip exports.',
              },
            ].map((step) => (
              <li key={step.num} className="flex items-start gap-3.5">
                <span className="font-mono text-xs font-medium text-[#E5A93C] pt-0.5">
                  {step.num}
                </span>
                <div>
                  <div className="text-sm font-medium text-[#E6E9EE]">{step.title}</div>
                  <div className="mt-0.5 text-xs leading-relaxed text-[#8892A0]">{step.desc}</div>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <div className="mt-8 border-t border-white/[0.08] pt-5 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-[#8892A0]">
          <span>Exports: MP3 · WAV · UTF-8 SRT · ZIP</span>
          <span aria-hidden="true">·</span>
          <span>
            LLM: {capabilities?.llmConfigured ? capabilities.llmModelLabel : 'Not configured'}
          </span>
        </div>
      </section>
    );
  }

  // Upload Error before job creation
  if (!job && uploadError) {
    return (
      <section
        id="output-section"
        className="rounded-xl border border-rose-500/30 bg-[#12151C] p-6 space-y-3"
      >
        <div className="flex items-center gap-2 text-rose-400">
          <AlertCircle className="h-5 w-5 shrink-0" />
          <h2 className="font-display text-base font-semibold">Unable to Start Dubbing</h2>
        </div>
        <p className="text-sm text-rose-200/90">{uploadError}</p>
      </section>
    );
  }

  // Uploading state before job returns
  if (!job && isUploading) {
    return (
      <section
        id="output-section"
        className="rounded-xl border border-white/[0.08] bg-[#12151C] p-6 space-y-4"
      >
        <div className="flex items-center gap-3">
          <Loader2 className="h-5 w-5 animate-spin text-[#E5A93C]" />
          <h2 className="font-display text-base font-semibold text-[#F1F3F5]">
            Uploading audio...
          </h2>
        </div>
        <p className="text-xs text-[#8892A0]">
          Transferring recording and validating audio stream parameters.
        </p>
      </section>
    );
  }

  if (!job) return null;

  const activeStageIndex = getStageIndex(job.stage);
  const completedLanguages = job.languages.filter((l) => l.status === 'completed');
  const existingCodes = new Set(job.languages.map((l) => l.languageCode));
  const availableExtraLanguages: SupportedLanguage[] = (capabilities?.supportedLanguages ?? []).filter(
    (l) => !existingCodes.has(l.code),
  );

  return (
    <div id="output-section" className="space-y-6">
      {/* Live Processing Status Tracker */}
      {(isRunning || job.stage === 'failed') && (
        <section className="rounded-xl border border-white/[0.08] bg-[#12151C] p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              {job.stage === 'failed' ? (
                <AlertCircle className="h-5 w-5 text-rose-400 shrink-0" />
              ) : (
                <Loader2 className="h-5 w-5 animate-spin text-[#E5A93C] shrink-0" />
              )}
              <div>
                <h2 className="font-display text-base font-semibold text-[#F1F3F5]">
                  {job.stage === 'failed' ? 'Dubbing Failed' : job.stageLabel}
                </h2>
                <p className="text-xs text-[#8892A0]">
                  {job.languages.length} target {job.languages.length === 1 ? 'language' : 'languages'}
                  {job.detectedSourceLanguage ? ` · Detected source: ${job.detectedSourceLanguage.toUpperCase()}` : ''}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {isRunning && (
                <span className="font-mono text-xs text-[#9BA3B0]">
                  Elapsed {formatDuration(elapsedSec)}
                </span>
              )}
              {job.stage === 'failed' && (
                <button
                  type="button"
                  onClick={() => onRetryJob()}
                  className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg bg-[#E5A93C] px-3.5 py-2 text-xs font-semibold text-[#0B0D11] hover:bg-[#EEB854] whitespace-nowrap"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Retry Failed Job
                </button>
              )}
            </div>
          </div>

          {job.error && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/[0.08] px-4 py-3 text-xs leading-relaxed text-rose-200">
              {job.error}
            </div>
          )}

          {/* Stage Checklist (no invented fake percentage) */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 border-t border-white/[0.06] pt-4">
            {PIPELINE_STEPS.map((step, idx) => {
              const isDone = job.stage === 'completed' || (job.stage !== 'failed' && idx < activeStageIndex);
              const isCurrent = job.stage !== 'failed' && idx === activeStageIndex;
              return (
                <div
                  key={step.stage}
                  className={`flex items-center gap-2.5 text-xs ${
                    isCurrent
                      ? 'font-medium text-[#F1F3F5]'
                      : isDone
                        ? 'text-emerald-400'
                        : 'text-[#667080]'
                  }`}
                >
                  {isDone ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  ) : isCurrent ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#E5A93C]" />
                  ) : (
                    <span className="h-3.5 w-3.5 shrink-0 rounded-full border border-white/15 inline-block" />
                  )}
                  <span>{step.label}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Original Audio Reference Card */}
      <section className="rounded-xl border border-white/[0.08] bg-[#12151C] p-5 space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h2 className="font-display text-sm font-semibold text-[#F1F3F5]">
              Original Audio
            </h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-[#8892A0]">
              <span className="text-[#C4CBD4]">{job.originalAudio.originalFilename}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono">{formatDuration(job.originalAudio.durationSec)}</span>
              {job.detectedSourceLanguage && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>Source: {job.detectedSourceLanguage.toUpperCase()}</span>
                </>
              )}
            </div>
          </div>

          {job.sourceTranscription?.text && (
            <button
              type="button"
              onClick={() => setShowSourceTranscript((v) => !v)}
              className="inline-flex items-center gap-1 text-xs font-medium text-[#9BA3B0] hover:text-[#F1F3F5] whitespace-nowrap"
            >
              {showSourceTranscript ? 'Hide Transcript' : 'Source Transcript'}
              {showSourceTranscript ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>

        <AudioWaveformPlayer
          src={job.originalAudioUrl}
          peaks={job.originalAudio.waveformPeaks}
          durationSec={job.originalAudio.durationSec}
          compact
        />

        {showSourceTranscript && job.sourceTranscription?.text && (
          <p className="rounded-lg border border-white/[0.06] bg-[#0B0D11] p-3 text-xs leading-relaxed text-[#C4CBD4]">
            {job.sourceTranscription.text}
          </p>
        )}
      </section>

      {/* Results Action Toolbar (Shown once at least 1 language is completed) */}
      {completedLanguages.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-[#12151C] px-5 py-4">
          <div className="flex flex-wrap items-center gap-2.5">
            <a
              href={`/api/jobs/${job.id}/download-all`}
              className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-[#E5A93C] px-4 py-2 text-xs font-semibold text-[#0B0D11] transition-colors hover:bg-[#EEB854] whitespace-nowrap"
            >
              <FolderArchive className="h-4 w-4" />
              Download All Generated Audio & SRT (ZIP)
            </a>

            {availableExtraLanguages.length > 0 && !isRunning && (
              <button
                type="button"
                onClick={() => setShowAddLanguage((v) => !v)}
                className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-white/[0.14] bg-[#171B24] px-3.5 py-2 text-xs font-medium text-[#F1F3F5] hover:bg-[#1E2430] whitespace-nowrap"
              >
                <Plus className="h-3.5 w-3.5 text-[#E5A93C]" />
                Generate Another Language
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onStartNewProject}
              className="inline-flex min-h-[40px] items-center rounded-lg border border-white/[0.12] px-3.5 py-2 text-xs font-medium text-[#C4CBD4] hover:bg-white/[0.06] hover:text-[#F1F3F5] whitespace-nowrap"
            >
              Start a New Project
            </button>
            <button
              type="button"
              onClick={onDeleteProject}
              title="Delete project and remove audio files from server"
              aria-label="Delete project files"
              className="inline-flex min-h-[40px] min-w-[40px] items-center justify-center rounded-lg border border-white/[0.12] text-[#8892A0] hover:border-rose-500/40 hover:text-rose-400"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Inline Add Another Language Drawer */}
      {showAddLanguage && availableExtraLanguages.length > 0 && (
        <section className="rounded-xl border border-white/[0.12] bg-[#141820] p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-display text-sm font-semibold text-[#F1F3F5]">
              Add Target Languages to This Project
            </h3>
            <button
              type="button"
              onClick={() => setShowAddLanguage(false)}
              className="text-xs text-[#8892A0] hover:text-[#F1F3F5]"
            >
              Cancel
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {availableExtraLanguages.map((lang) => {
              const selected = extraLangCodes.includes(lang.code);
              return (
                <button
                  key={lang.code}
                  type="button"
                  onClick={() =>
                    setExtraLangCodes((prev) =>
                      prev.includes(lang.code)
                        ? prev.filter((c) => c !== lang.code)
                        : [...prev, lang.code],
                    )
                  }
                  className={`min-h-[40px] rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                    selected
                      ? 'border-[#E5A93C]/70 bg-[#E5A93C]/[0.1] text-[#F1F3F5]'
                      : 'border-white/[0.08] bg-[#0E1117] text-[#C4CBD4] hover:border-white/[0.18]'
                  }`}
                >
                  <div className="font-medium truncate">{lang.name}</div>
                  <div className="text-[11px] text-[#8892A0] truncate">{lang.nativeName}</div>
                </button>
              );
            })}
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              disabled={extraLangCodes.length === 0}
              onClick={() => {
                onAddLanguages(extraLangCodes);
                setExtraLangCodes([]);
                setShowAddLanguage(false);
              }}
              className="min-h-[40px] rounded-lg bg-[#E5A93C] px-4 py-2 text-xs font-semibold text-[#0B0D11] hover:bg-[#EEB854] disabled:opacity-40 whitespace-nowrap"
            >
              Generate Selected ({extraLangCodes.length})
            </button>
          </div>
        </section>
      )}

      {/* Per-Language Generated Outputs */}
      <div className="space-y-4">
        {job.languages.map((lang) => (
          <LanguageResultCard
            key={lang.languageCode}
            lang={lang}
            onRetryLanguage={(code) => onRetryJob(code)}
            onRetrySubtitles={(code) => onRetrySubtitles(code)}
          />
        ))}
      </div>
    </div>
  );
}
