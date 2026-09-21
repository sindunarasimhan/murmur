import type { TranscriptCue, TranscriptSource } from '@/domain/podcast';

function parseTimestamp(value: string): number | undefined {
  const normalized = value.trim().replace(',', '.');
  const parts = normalized.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return undefined;
  const [first = 0, second = 0, third = 0] = parts;

  if (parts.length === 2) return first * 60 + second;
  if (parts.length === 3) return first * 3600 + second * 60 + third;
  return undefined;
}

function cleanCueText(lines: string[]): string {
  return lines
    .join(' ')
    .replace(/<v\s+([^>]+)>/gi, '$1: ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([\da-f]+);/gi, (match, hexadecimal: string) => {
      const codePoint = Number.parseInt(hexadecimal, 16);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    })
    .replace(/&#(\d+);/g, (match, decimal: string) => {
      const codePoint = Number.parseInt(decimal, 10);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    })
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function validTiming(startSeconds: number | undefined, endSeconds: number | undefined) {
  return (
    startSeconds !== undefined &&
    endSeconds !== undefined &&
    Number.isFinite(startSeconds) &&
    Number.isFinite(endSeconds) &&
    startSeconds >= 0 &&
    endSeconds > startSeconds
  );
}

function sortCues(cues: TranscriptCue[]): TranscriptCue[] {
  return cues.sort((left, right) => left.startSeconds - right.startSeconds);
}

function parseTimedText(input: string): TranscriptCue[] {
  const blocks = input
    .replace(/^\uFEFF/, '')
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  return sortCues(blocks.flatMap((block, blockIndex) => {
    const lines = block.split(/\r?\n/).map((line) => line.trim());
    if (lines[0]?.toUpperCase().startsWith('WEBVTT')) return [];

    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) return [];

    const timingLine = lines[timingIndex];
    if (!timingLine) return [];
    const [rawStart, rawEndWithSettings] = timingLine.split('-->');
    const rawEnd = rawEndWithSettings?.trim().split(/\s+/)[0];
    const startSeconds = rawStart ? parseTimestamp(rawStart) : undefined;
    const endSeconds = rawEnd ? parseTimestamp(rawEnd) : undefined;
    const text = cleanCueText(lines.slice(timingIndex + 1));

    if (
      startSeconds === undefined ||
      endSeconds === undefined ||
      !validTiming(startSeconds, endSeconds) ||
      !text
    ) {
      return [];
    }

    return [
      {
        id: `cue-${blockIndex}-${Math.round(startSeconds * 1000)}`,
        startSeconds,
        endSeconds,
        text,
      },
    ];
  }));
}

type JsonCue = {
  startTime?: unknown;
  start?: unknown;
  endTime?: unknown;
  end?: unknown;
  duration?: unknown;
  body?: unknown;
  text?: unknown;
  speaker?: unknown;
};

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
}

function parseJsonTranscript(input: string): TranscriptCue[] {
  const parsed = JSON.parse(input) as unknown;
  const root = parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  const candidates = Array.isArray(root)
    ? root
    : root && 'segments' in root && Array.isArray(root.segments)
      ? root.segments
      : root && 'transcript' in root && Array.isArray(root.transcript)
        ? root.transcript
        : [];

  return sortCues(candidates.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const cue = candidate as JsonCue;
    const startSeconds = finiteNumber(cue.startTime ?? cue.start);
    const explicitEnd = finiteNumber(cue.endTime ?? cue.end);
    const duration = finiteNumber(cue.duration);
    const endSeconds = explicitEnd ?? (startSeconds !== undefined && duration !== undefined
      ? startSeconds + duration
      : undefined);
    const textValue = cue.body ?? cue.text;
    const text = typeof textValue === 'string' ? textValue.trim() : '';
    const speaker = typeof cue.speaker === 'string' ? cue.speaker.trim() : undefined;

    if (
      startSeconds === undefined ||
      endSeconds === undefined ||
      !validTiming(startSeconds, endSeconds) ||
      !text
    ) {
      return [];
    }

    return [
      {
        id: `cue-${index}-${Math.round(startSeconds * 1000)}`,
        startSeconds,
        endSeconds,
        text,
        speaker: speaker || undefined,
      },
    ];
  }));
}

export function parseTranscript(
  contents: string,
  source: Pick<TranscriptSource, 'kind'>,
): TranscriptCue[] {
  if (source.kind === 'vtt' || source.kind === 'srt') {
    return parseTimedText(contents);
  }
  if (source.kind === 'json') {
    return parseJsonTranscript(contents);
  }
  return [];
}

export function transcriptWindow(
  transcript: TranscriptCue[],
  currentSeconds: number,
  beforeSeconds = 75,
  afterSeconds = 20,
): TranscriptCue[] {
  const from = Math.max(0, currentSeconds - beforeSeconds);
  const to = currentSeconds + afterSeconds;
  return transcript.filter(
    (cue) => cue.endSeconds >= from && cue.startSeconds <= to,
  );
}
