import { useCallback, useEffect, useRef, useState } from 'react';
import { Header } from './components/Header';
import { ResultsAndProgressPanel } from './components/ResultsAndProgressPanel';
import { StudioConfigPanel } from './components/StudioConfigPanel';
import type {
  AudioMetadata,
  ClientDubbingJob,
  DubbingSettings,
  SystemCapabilities,
} from './types/dubbing';
import { decodeLocalAudioInfo } from './utils/formatters';

const DEFAULT_SETTINGS: DubbingSettings = {
  preserveSpeakerIdentity: true,
  preserveNarrationStyle: true,
  preserveEmotionalExpression: true,
  preserveRhythmAndPacing: true,
  preserveVocalCharacteristics: true,
  workflowMode: 'auto',
};

const ACTIVE_JOB_STORAGE_KEY = 'resonance_active_job_id';

async function parseApiJson<T>(res: Response): Promise<T> {
  const raw = await res.text();
  const trimmed = raw.trim();
  if (trimmed.startsWith('<')) {
    if (res.status === 413) {
      throw new Error(
        'Audio file is too large for the hosting proxy limit (max ~30 MB over HTTP/1). Try a compressed MP3/M4A under 30 MB.',
      );
    }
    throw new Error(
      `Server returned an HTML response (HTTP ${res.status}) instead of JSON. If you just updated secrets or opened a static preview, use the Development App URL or reload after the server finishes restarting.`,
    );
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Invalid server response (HTTP ${res.status}): ${trimmed.slice(0, 160)}`);
  }
}

export default function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [capabilities, setCapabilities] = useState<SystemCapabilities | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null);
  const [audioMeta, setAudioMeta] = useState<AudioMetadata | null>(null);
  const [isInspectingAudio, setIsInspectingAudio] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);

  const [sourceLanguage, setSourceLanguage] = useState<string>('auto');
  const [targetLanguages, setTargetLanguages] = useState<string[]>(['ja']);
  const [settings, setSettings] = useState<DubbingSettings>(DEFAULT_SETTINGS);
  const [voiceCloneAuthorized, setVoiceCloneAuthorized] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [job, setJob] = useState<ClientDubbingJob | null>(null);

  // Load sanitized server capabilities and restore active job if present
  useEffect(() => {
    fetch('/api/capabilities')
      .then((res) => parseApiJson<SystemCapabilities>(res))
      .then((data: SystemCapabilities) => {
        setCapabilities(data);
        if (
          data.voiceProvider.startsWith('gemini') ||
          (!data.voiceProviderConfigured && data.geminiConfigured)
        ) {
          setSettings((prev) => ({ ...prev, workflowMode: 'gemini_only' }));
        }
        if (data.supportedLanguages.length > 0) {
          setTargetLanguages((prev) => {
            const valid = prev.filter((c) => data.supportedLanguages.some((l) => l.code === c));
            return valid.length > 0 ? valid : [data.supportedLanguages[0].code];
          });
        }
      })
      .catch(() => {});

    const savedJobId = window.sessionStorage.getItem(ACTIVE_JOB_STORAGE_KEY);
    if (savedJobId) {
      fetch(`/api/jobs/${encodeURIComponent(savedJobId)}`)
        .then((res) => (res.ok ? parseApiJson<{ job?: ClientDubbingJob }>(res) : null))
        .then((data: { job?: ClientDubbingJob } | null) => {
          if (data?.job) setJob(data.job);
          else window.sessionStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
        })
        .catch(() => {});
    }
  }, []);

  // Poll running dubbing job status
  useEffect(() => {
    if (!job || job.stage === 'completed' || job.stage === 'failed') return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${encodeURIComponent(job.id)}`);
        if (!res.ok) return;
        const data = await parseApiJson<{ job: ClientDubbingJob }>(res);
        setJob(data.job);
      } catch {
        // Keep polling on transient network blip
      }
    }, 1800);

    return () => clearInterval(interval);
  }, [job]);

  // Cleanup object URL on change/unmount
  useEffect(() => {
    return () => {
      if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
    };
  }, [localPreviewUrl]);

  const handleFileSelected = useCallback(async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!['mp3', 'wav', 'm4a'].includes(ext)) {
      setInspectError('Unsupported file format. Please upload an MP3, WAV, or M4A audio file.');
      return;
    }

    const maxBytes = (capabilities?.maxUploadMb ?? 50) * 1024 * 1024;
    if (file.size > maxBytes) {
      setInspectError(`File size exceeds maximum limit of ${capabilities?.maxUploadMb ?? 50} MB.`);
      return;
    }

    if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
    const previewUrl = URL.createObjectURL(file);

    setSelectedFile(file);
    setLocalPreviewUrl(previewUrl);
    setInspectError(null);
    setUploadError(null);
    setIsInspectingAudio(true);

    // Instant client-side waveform & duration decode first
    try {
      const localInfo = await decodeLocalAudioInfo(file, 96);
      setAudioMeta({
        originalFilename: file.name,
        mimeType: file.type || 'audio/mpeg',
        sizeBytes: file.size,
        durationSec: localInfo.durationSec,
        sampleRate: localInfo.sampleRate,
        channels: localInfo.channels,
        codec: ext,
        waveformPeaks: localInfo.waveformPeaks,
      });
    } catch {
      // Server ffprobe below will still validate MP3/WAV/M4A reliably
    }

    // Authoritative server-side ffprobe validation
    try {
      const form = new FormData();
      form.append('audio', file);
      const res = await fetch('/api/audio/inspect', { method: 'POST', body: form });
      const data = await parseApiJson<{ metadata?: AudioMetadata; error?: string }>(res);
      if (!res.ok || !data.metadata) {
        throw new Error(data.error || 'Could not validate uploaded audio file.');
      }
      setAudioMeta(data.metadata);
      setInspectError(null);
    } catch (err) {
      setInspectError(err instanceof Error ? err.message : 'Failed to validate audio file.');
    } finally {
      setIsInspectingAudio(false);
    }
  }, [capabilities?.maxUploadMb, localPreviewUrl]);

  const handleClearFile = () => {
    if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
    setSelectedFile(null);
    setLocalPreviewUrl(null);
    setAudioMeta(null);
    setInspectError(null);
    setUploadError(null);
  };

  const handleToggleTargetLanguage = (code: string) => {
    setTargetLanguages((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );
  };

  const handleGenerate = async () => {
    if (!selectedFile) return;
    setIsSubmitting(true);
    setUploadError(null);

    try {
      const form = new FormData();
      form.append('audio', selectedFile);
      form.append('sourceLanguage', sourceLanguage);
      form.append('targetLanguages', JSON.stringify(targetLanguages));
      form.append('settings', JSON.stringify(settings));
      form.append('voiceCloneAuthorized', String(voiceCloneAuthorized));

      const res = await fetch('/api/jobs', {
        method: 'POST',
        body: form,
      });
      const data = await parseApiJson<{ job?: ClientDubbingJob; error?: string }>(res);
      if (!res.ok || !data.job) {
        throw new Error(data.error || 'Failed to start dubbing job.');
      }

      setJob(data.job);
      window.sessionStorage.setItem(ACTIVE_JOB_STORAGE_KEY, data.job.id);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Failed to submit dubbing job.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRetryJob = async (languageCode?: string) => {
    if (!job) return;
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ languageCode }),
      });
      const data = await parseApiJson<{ job?: ClientDubbingJob; error?: string }>(res);
      if (res.ok && data.job) {
        setJob(data.job);
      } else if (data.error) {
        setUploadError(data.error);
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Retry request failed.');
    }
  };

  const handleRetrySubtitles = async (languageCode: string) => {
    if (!job) return;
    try {
      const res = await fetch(
        `/api/jobs/${encodeURIComponent(job.id)}/languages/${encodeURIComponent(languageCode)}/retry-subtitles`,
        { method: 'POST' },
      );
      const data = await parseApiJson<{ job?: ClientDubbingJob }>(res);
      if (res.ok && data.job) {
        setJob(data.job);
      }
    } catch {
      // Ignore transient failure
    }
  };

  const handleAddLanguages = async (codes: string[]) => {
    if (!job || codes.length === 0) return;
    const res = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/languages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetLanguages: codes }),
    });
    const data = await parseApiJson<{ job?: ClientDubbingJob }>(res);
    if (res.ok && data.job) {
      setJob(data.job);
    }
  };

  const handleResetProject = () => {
    handleClearFile();
    setJob(null);
    setUploadError(null);
    setVoiceCloneAuthorized(false);
    window.sessionStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
  };

  const handleDeleteProject = async () => {
    if (job) {
      await fetch(`/api/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' }).catch(() => {});
    }
    handleResetProject();
  };

  const isJobLocked =
    isSubmitting ||
    (job !== null && job.stage !== 'completed' && job.stage !== 'failed');

  return (
    <div id="studio" className="min-h-screen bg-[#0B0D11] text-[#F1F3F5]">
      <Header
        hasActiveJob={Boolean(job)}
        onResetProject={handleResetProject}
        onTriggerUpload={() => fileInputRef.current?.click()}
      />

      <main className="mx-auto max-w-[1280px] px-6 py-8 lg:py-10">
        {/* Focused Studio Headline */}
        <div className="mb-8 border-b border-white/[0.08] pb-6">
          <h1 className="font-display text-2xl font-semibold tracking-tight text-[#F1F3F5] sm:text-3xl [text-wrap:balance]">
            Multilingual Voice Dubbing Studio
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#9BA3B0]">
            Upload an original voice recording, translate with your configured external LLM, preserve the speaker&apos;s voice and delivery across languages, and export MP3, WAV, and synchronized SRT subtitles.
          </p>
        </div>

        {/* Two-Column Studio Workspace */}
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12 lg:items-start">
          <div className="lg:col-span-5">
            <StudioConfigPanel
              fileInputRef={fileInputRef}
              selectedFile={selectedFile}
              localPreviewUrl={localPreviewUrl}
              audioMeta={audioMeta}
              isInspectingAudio={isInspectingAudio}
              inspectError={inspectError}
              capabilities={capabilities}
              sourceLanguage={sourceLanguage}
              targetLanguages={targetLanguages}
              settings={settings}
              voiceCloneAuthorized={voiceCloneAuthorized}
              isSubmitting={isSubmitting}
              isLocked={isJobLocked}
              onFileSelected={handleFileSelected}
              onClearFile={handleClearFile}
              onSourceLanguageChange={setSourceLanguage}
              onToggleTargetLanguage={handleToggleTargetLanguage}
              onClearTargetLanguages={() => setTargetLanguages([])}
              onSettingsChange={setSettings}
              onAuthorizationChange={setVoiceCloneAuthorized}
              onGenerate={handleGenerate}
            />
          </div>

          <div className="lg:col-span-7">
            <ResultsAndProgressPanel
              job={job}
              isUploading={isSubmitting}
              uploadError={uploadError}
              capabilities={capabilities}
              onRetryJob={handleRetryJob}
              onRetrySubtitles={handleRetrySubtitles}
              onAddLanguages={handleAddLanguages}
              onStartNewProject={handleResetProject}
              onDeleteProject={handleDeleteProject}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
