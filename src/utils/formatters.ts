export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const totalSec = Math.floor(seconds);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

export async function decodeLocalAudioInfo(
  file: File,
  buckets = 96,
): Promise<{ durationSec: number; sampleRate: number; channels: number; waveformPeaks: number[] }> {
  const arrayBuf = await file.arrayBuffer();
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuf.slice(0));
    const channelData = audioBuffer.getChannelData(0);
    const step = Math.max(1, Math.floor(channelData.length / buckets));
    const peaks: number[] = [];
    let maxPeak = 0.001;

    for (let i = 0; i < buckets; i++) {
      const start = i * step;
      const end = Math.min(channelData.length, start + step);
      let peak = 0;
      const stride = Math.max(1, Math.floor((end - start) / 100));
      for (let j = start; j < end; j += stride) {
        const val = Math.abs(channelData[j]);
        if (val > peak) peak = val;
      }
      if (peak > maxPeak) maxPeak = peak;
      peaks.push(peak);
    }

    return {
      durationSec: audioBuffer.duration,
      sampleRate: audioBuffer.sampleRate,
      channels: audioBuffer.numberOfChannels,
      waveformPeaks: peaks.map((p) => Number(Math.max(0.05, Math.min(1, p / maxPeak)).toFixed(3))),
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}
