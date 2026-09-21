import type { PodcastEpisode, TranscriptCue } from '@/domain/podcast';
import { transcriptWindow } from '@/services/rss/parse-transcript';

const MAX_CONTEXT_CHARACTERS = 12_000;
const MAX_CONTEXT_CUES = 60;

type FormattedCue = {
  startSeconds: number;
  endSeconds: number;
  line: string;
};

function formatTimestamp(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainingSeconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function cleanCueText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function buildEpisodeMetadataContext(
  episode: Pick<PodcastEpisode, 'description' | 'podcastTitle' | 'title'>,
  positionSeconds: number,
): string {
  const description = cleanCueText(episode.description).slice(0, 8_000);
  return [
    '[Context availability: episode metadata only. No usable timed transcript is available. Do not claim or quote what was said at the current playback moment. Answer general or conceptual questions from the metadata, conversation history, and general knowledge; say briefly when the question requires exact audio context.]',
    `Show: ${cleanCueText(episode.podcastTitle)}`,
    `Episode: ${cleanCueText(episode.title)}`,
    `Playback position: ${formatTimestamp(positionSeconds)}`,
    description ? `Publisher description: ${description}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function distanceFromPosition(cue: FormattedCue, positionSeconds: number): number {
  if (positionSeconds < cue.startSeconds) return cue.startSeconds - positionSeconds;
  if (positionSeconds > cue.endSeconds) return positionSeconds - cue.endSeconds;
  return 0;
}

export function buildTranscriptContext(
  transcript: readonly TranscriptCue[],
  positionSeconds: number,
): string {
  const nearest = transcriptWindow([...transcript], positionSeconds).flatMap<FormattedCue>((cue) => {
    const text = cleanCueText(cue.text);
    if (!text) return [];

    const alignment = cue.endSeconds - cue.startSeconds > 30 ? 'section timing' : 'timed cue';
    const speaker = cue.speaker ? `${cleanCueText(cue.speaker)}: ` : '';
    return [
      {
        startSeconds: cue.startSeconds,
        endSeconds: cue.endSeconds,
        line: `[${formatTimestamp(cue.startSeconds)}–${formatTimestamp(cue.endSeconds)}; ${alignment}] ${speaker}${text}`,
      },
    ];
  }).sort((left, right) => {
    const distance =
      distanceFromPosition(left, positionSeconds) -
      distanceFromPosition(right, positionSeconds);
    if (distance !== 0) return distance;

    const leftMidpoint = (left.startSeconds + left.endSeconds) / 2;
    const rightMidpoint = (right.startSeconds + right.endSeconds) / 2;
    return (
      Math.abs(leftMidpoint - positionSeconds) -
        Math.abs(rightMidpoint - positionSeconds) ||
      left.startSeconds - right.startSeconds
    );
  }).slice(0, MAX_CONTEXT_CUES);

  const selected: FormattedCue[] = [];
  let selectedCharacters = 0;
  for (const cue of nearest) {
    const separatorCharacters = selected.length > 0 ? 1 : 0;
    const remaining = MAX_CONTEXT_CHARACTERS - selectedCharacters - separatorCharacters;
    if (remaining <= 0) break;

    if (cue.line.length <= remaining) {
      selected.push(cue);
      selectedCharacters += separatorCharacters + cue.line.length;
      continue;
    }

    if (selected.length === 0) {
      selected.push({
        ...cue,
        line: `${cue.line.slice(0, MAX_CONTEXT_CHARACTERS - 1).trimEnd()}…`,
      });
      selectedCharacters = MAX_CONTEXT_CHARACTERS;
    }
  }

  return selected
    .sort((left, right) => left.startSeconds - right.startSeconds)
    .map((cue) => cue.line)
    .join('\n');
}
