import type { WordTimestamp } from '../types.ts';

export interface SrtCue {
  index: number;
  start: number;
  end: number;
  text: string;
}

export interface SrtValidationResult {
  valid: boolean;
  cueCount: number;
  errors: string[];
}

const CJK_OR_THAI_REGEX = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\u0e00-\u0e7f]/;
const SENTENCE_END_REGEX = /[.!?。！？]$/;
const CLAUSE_BREAK_REGEX = /[,;、，；:：]$/;

export function formatSrtTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const totalMs = Math.round(clamped * 1000);
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function parseSrtTimestamp(ts: string): number | null {
  const match = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(ts.trim());
  if (!match) return null;
  const h = Number.parseInt(match[1], 10);
  const m = Number.parseInt(match[2], 10);
  const s = Number.parseInt(match[3], 10);
  const ms = Number.parseInt(match[4], 10);
  if (m >= 60 || s >= 60) return null;
  return h * 3600 + m * 60 + s + ms / 1000;
}

function wrapSubtitleLines(text: string, maxCharsPerLine: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxCharsPerLine) return clean;

  // For CJK / Thai without spaces, split cleanly near midpoint
  if (!clean.includes(' ') && CJK_OR_THAI_REGEX.test(clean)) {
    const mid = Math.ceil(clean.length / 2);
    return `${clean.slice(0, mid)}\n${clean.slice(mid)}`;
  }

  const words = clean.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const w of words) {
    if (!current) {
      current = w;
    } else if (current.length + 1 + w.length <= maxCharsPerLine) {
      current += ` ${w}`;
    } else {
      lines.push(current);
      current = w;
      if (lines.length === 2) {
        // Append remainder to second line rather than exceeding 2 lines
        current = `${lines.pop()} ${current}`;
      }
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 2).join('\n');
}

/**
 * Builds valid, readable SRT subtitles exclusively from real timestamped tokens
 * (never estimates timing from text length).
 */
export function buildSrtFromWords(
  rawWords: WordTimestamp[],
  audioDurationSec: number,
  targetLanguageCode: string,
): { srtContent: string; cues: SrtCue[] } {
  const words = rawWords
    .filter((w) => w.text && w.text.trim().length > 0 && Number.isFinite(w.start) && Number.isFinite(w.end))
    .map((w) => ({
      text: w.text,
      start: Math.max(0, Math.min(w.start, audioDurationSec)),
      end: Math.max(0, Math.min(w.end, audioDurationSec)),
    }))
    .filter((w) => w.end >= w.start)
    .sort((a, b) => a.start - b.start);

  if (words.length === 0) {
    throw new Error('No timestamped speech tokens were returned to build subtitles.');
  }

  const isCompactScript = ['ja', 'zh', 'ko', 'th'].includes(targetLanguageCode.toLowerCase());
  const maxCueChars = isCompactScript ? 36 : 76;
  const maxCharsPerLine = isCompactScript ? 18 : 40;
  const maxCueDurationSec = 6.2;
  const pauseThresholdSec = 0.48;

  const rawCues: Array<{ start: number; end: number; text: string }> = [];
  let buffer: typeof words = [];

  const flushBuffer = () => {
    if (buffer.length === 0) return;
    const joined = isCompactScript
      ? buffer.map((t) => t.text.trim()).join('')
      : buffer
          .map((t) => t.text.trim())
          .join(' ')
          .replace(/\s+([,.!?;:)\]\}])/g, '$1');

    const cleaned = joined.trim();
    if (cleaned.length > 0) {
      const start = buffer[0].start;
      let end = Math.max(buffer[buffer.length - 1].end, start + 0.15);
      end = Math.min(end, audioDurationSec);
      if (end > start) {
        rawCues.push({
          start,
          end,
          text: wrapSubtitleLines(cleaned, maxCharsPerLine),
        });
      }
    }
    buffer = [];
  };

  for (let i = 0; i < words.length; i++) {
    const token = words[i];
    const prev = buffer[buffer.length - 1];

    if (prev) {
      const gap = token.start - prev.end;
      const currentSpan = token.end - buffer[0].start;
      const projectedLength =
        buffer.reduce((sum, w) => sum + w.text.trim().length + (isCompactScript ? 0 : 1), 0) +
        token.text.trim().length;

      const prevEndedSentence = SENTENCE_END_REGEX.test(prev.text.trim());
      const prevEndedClause = CLAUSE_BREAK_REGEX.test(prev.text.trim());

      if (
        prevEndedSentence ||
        gap >= pauseThresholdSec ||
        currentSpan >= maxCueDurationSec ||
        projectedLength > maxCueChars ||
        (prevEndedClause && projectedLength > maxCueChars * 0.55)
      ) {
        flushBuffer();
      }
    }

    buffer.push(token);
  }
  flushBuffer();

  // Enforce strict chronological ordering and non-overlapping timestamps
  const cues: SrtCue[] = [];
  let prevEnd = 0;

  for (const cue of rawCues) {
    let start = Math.max(cue.start, prevEnd);
    let end = Math.min(cue.end, audioDurationSec);
    if (end <= start) {
      // Shift slightly if needed while staying strictly within audioDurationSec
      if (start + 0.08 <= audioDurationSec) {
        end = Math.min(audioDurationSec, start + 0.12);
      } else {
        continue;
      }
    }

    // Ensure millisecond rounding preserves strict chronological non-overlap
    const startMs = Math.round(start * 1000);
    const endMs = Math.round(end * 1000);
    if (endMs <= startMs) continue;

    cues.push({
      index: cues.length + 1,
      start: startMs / 1000,
      end: endMs / 1000,
      text: cue.text,
    });
    prevEnd = endMs / 1000;
  }

  if (cues.length === 0) {
    throw new Error('Generated subtitle cues were empty after timeline synchronization.');
  }

  const srtContent =
    cues
      .map(
        (c) =>
          `${c.index}\n${formatSrtTimestamp(c.start)} --> ${formatSrtTimestamp(c.end)}\n${c.text}`,
      )
      .join('\n\n') + '\n';

  return { srtContent, cues };
}

/**
 * Validates SRT syntax, ordering, non-overlap, and duration boundaries before allowing download.
 */
export function validateSrt(srtContent: string, audioDurationSec: number): SrtValidationResult {
  const errors: string[] = [];
  const normalized = srtContent.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();

  if (!normalized) {
    return { valid: false, cueCount: 0, errors: ['SRT content is empty.'] };
  }

  const blocks = normalized.split(/\n{2,}/);
  let lastEnd = 0;

  for (let i = 0; i < blocks.length; i++) {
    const lines = blocks[i].split('\n').map((l) => l.trimEnd());
    if (lines.length < 3) {
      errors.push(`Block ${i + 1} is malformed (expected index, timing line, and text).`);
      continue;
    }

    const idx = Number.parseInt(lines[0].trim(), 10);
    if (idx !== i + 1) {
      errors.push(`Cue ${i + 1} has invalid sequential index (${lines[0]}).`);
    }

    const timeParts = lines[1].split('-->');
    if (timeParts.length !== 2) {
      errors.push(`Cue ${i + 1} has invalid timecode separator.`);
      continue;
    }

    const start = parseSrtTimestamp(timeParts[0]);
    const end = parseSrtTimestamp(timeParts[1]);
    if (start === null || end === null) {
      errors.push(`Cue ${i + 1} has invalid HH:MM:SS,mmm timestamp format.`);
      continue;
    }

    if (end <= start) {
      errors.push(`Cue ${i + 1} end time (${end}) is not after start time (${start}).`);
    }

    if (start < lastEnd - 0.001) {
      errors.push(`Cue ${i + 1} overlaps with previous cue (${start} < ${lastEnd}).`);
    }

    if (end > audioDurationSec + 0.05) {
      errors.push(
        `Cue ${i + 1} exceeds dubbed audio duration (${end.toFixed(3)}s > ${audioDurationSec.toFixed(3)}s).`,
      );
    }

    const text = lines.slice(2).join('\n').trim();
    if (!text) {
      errors.push(`Cue ${i + 1} has empty subtitle text.`);
    }

    lastEnd = end;
  }

  return {
    valid: errors.length === 0,
    cueCount: blocks.length,
    errors,
  };
}

/**
 * Parses an existing SRT string (for example returned by provider transcript endpoint),
 * clamps all timestamps to audioDurationSec, removes overlaps, and re-serializes cleanly.
 */
export function normalizeAndClampSrt(rawSrt: string, audioDurationSec: number): { srtContent: string; cueCount: number } {
  const normalized = rawSrt.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    throw new Error('Provider returned an empty SRT transcript.');
  }

  const blocks = normalized.split(/\n{2,}/);
  const cues: SrtCue[] = [];
  let prevEnd = 0;

  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length < 3) continue;
    const timeParts = lines[1].split('-->');
    if (timeParts.length !== 2) continue;
    const rawStart = parseSrtTimestamp(timeParts[0]);
    const rawEnd = parseSrtTimestamp(timeParts[1]);
    if (rawStart === null || rawEnd === null) continue;

    const text = lines.slice(2).join('\n').trim();
    if (!text) continue;

    const start = Math.max(prevEnd, Math.min(rawStart, audioDurationSec));
    const end = Math.min(rawEnd, audioDurationSec);
    if (end <= start + 0.04) continue;

    cues.push({
      index: cues.length + 1,
      start,
      end,
      text,
    });
    prevEnd = end;
  }

  if (cues.length === 0) {
    throw new Error('No valid subtitle cues remained after synchronization.');
  }

  const srtContent =
    cues
      .map(
        (c) =>
          `${c.index}\n${formatSrtTimestamp(c.start)} --> ${formatSrtTimestamp(c.end)}\n${c.text}`,
      )
      .join('\n\n') + '\n';

  return { srtContent, cueCount: cues.length };
}
