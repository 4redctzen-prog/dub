import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { formatDuration } from '../utils/formatters';

interface AudioWaveformPlayerProps {
  src: string;
  peaks: number[];
  durationSec?: number;
  label?: string;
  compact?: boolean;
}

export function AudioWaveformPlayer({
  src,
  peaks,
  durationSec,
  label,
  compact = false,
}: AudioWaveformPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [resolvedDuration, setResolvedDuration] = useState<number>(durationSec ?? 0);
  const [hoverProgress, setHoverProgress] = useState<number | null>(null);

  useEffect(() => {
    if (durationSec && durationSec > 0) {
      setResolvedDuration(durationSec);
    }
  }, [durationSec]);

  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
  }, [src]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const bars = peaks.length > 0 ? peaks : Array.from({ length: 84 }, () => 0.16);
    const barCount = bars.length;
    const gap = Math.max(1.5, Math.min(3, width / barCount / 3));
    const barWidth = Math.max(1.5, (width - gap * (barCount - 1)) / barCount);
    const progress = resolvedDuration > 0 ? Math.min(1, currentTime / resolvedDuration) : 0;

    for (let i = 0; i < barCount; i++) {
      const ratio = (i + 0.5) / barCount;
      const amp = Math.max(0.06, Math.min(1, bars[i]));
      const barHeight = Math.max(3, amp * (height - 4));
      const x = i * (barWidth + gap);
      const y = (height - barHeight) / 2;

      if (ratio <= progress) {
        ctx.fillStyle = '#E5A93C';
      } else if (hoverProgress !== null && ratio <= hoverProgress) {
        ctx.fillStyle = 'rgba(229, 169, 60, 0.45)';
      } else {
        ctx.fillStyle = 'rgba(241, 243, 245, 0.22)';
      }

      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, 1.5);
      ctx.fill();
    }
  }, [peaks, currentTime, resolvedDuration, hoverProgress]);

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      try {
        await audio.play();
        setIsPlaying(true);
      } catch {
        setIsPlaying(false);
      }
    }
  };

  const toggleMute = () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.muted = !audio.muted;
    setIsMuted(audio.muted);
  };

  const handleSeek = (clientX: number) => {
    const canvas = canvasRef.current;
    const audio = audioRef.current;
    if (!canvas || !audio || resolvedDuration <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const targetTime = ratio * resolvedDuration;
    audio.currentTime = targetTime;
    setCurrentTime(targetTime);
  };

  return (
    <div className="w-full">
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setResolvedDuration(d);
        }}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onEnded={() => setIsPlaying(false)}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
      />

      {label && (
        <div className="mb-1.5 text-xs font-medium text-[#9BA3B0]">{label}</div>
      )}

      <div className={`flex items-center gap-3 rounded-lg border border-white/[0.08] bg-[#0F1218] ${compact ? 'px-3 py-2' : 'px-3.5 py-2.5'}`}>
        <button
          type="button"
          onClick={togglePlay}
          aria-label={isPlaying ? 'Pause audio' : 'Play audio'}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[#E5A93C] text-[#0B0D11] transition-colors hover:bg-[#EEB854] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#E5A93C]"
        >
          {isPlaying ? <Pause className="h-4 w-4 fill-current" /> : <Play className="h-4 w-4 fill-current translate-x-[1px]" />}
        </button>

        <div className="relative flex-1 min-w-0">
          <canvas
            ref={canvasRef}
            onClick={(e) => handleSeek(e.clientX)}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setHoverProgress(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
            }}
            onMouseLeave={() => setHoverProgress(null)}
            className={`w-full cursor-pointer block ${compact ? 'h-9' : 'h-11'}`}
            aria-label="Audio waveform seek bar"
          />
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <span className="font-mono text-xs text-[#C4CBD4] whitespace-nowrap">
            {formatDuration(currentTime)} <span className="text-[#667080]">/</span> {formatDuration(resolvedDuration)}
          </span>
          <button
            type="button"
            onClick={toggleMute}
            aria-label={isMuted ? 'Unmute audio' : 'Mute audio'}
            className="flex h-9 w-9 items-center justify-center rounded-md text-[#9BA3B0] transition-colors hover:bg-white/[0.06] hover:text-[#F1F3F5] focus-visible:outline-2 focus-visible:outline-[#E5A93C]"
          >
            {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
