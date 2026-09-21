import type { PodcastEpisode, PodcastFeed, TranscriptCue } from '@/domain/podcast';
import { DEVELOPMENT_FEED_URL } from '@/data/fallback-catalog';
import { parsePodcastFeed, selectTranscriptSource } from './parse-podcast-feed';
import { parseTranscript } from './parse-transcript';

const MAX_FEED_CHARACTERS = 1_500_000;
const MAX_TRANSCRIPT_CHARACTERS = 4_000_000;
const REQUEST_TIMEOUT_MS = 12_000;

export const configuredFeedUrl =
  process.env.EXPO_PUBLIC_PODCAST_FEED_URL ?? (__DEV__ ? DEVELOPMENT_FEED_URL : undefined);

async function fetchText(
  url: string,
  maxCharacters: number,
  signal?: AbortSignal,
): Promise<string> {
  const parsedUrl = new URL(url);
  const localHttp =
    parsedUrl.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '::1'].includes(parsedUrl.hostname);
  if (parsedUrl.protocol !== 'https:' && !localHttp) {
    throw new Error('Murmur only loads secure remote podcast resources.');
  }

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => timeoutController.abort();
  signal?.addEventListener('abort', abort, { once: true });

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/rss+xml, application/xml, text/vtt, text/plain, application/json' },
      signal: timeoutController.signal,
    });
    if (!response.ok) throw new Error(`Request failed with HTTP ${response.status}.`);

    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxCharacters) {
      throw new Error('The response is larger than Murmur can safely process.');
    }

    const contents = await response.text();
    if (contents.length > maxCharacters) {
      throw new Error('The response is larger than Murmur can safely process.');
    }
    return contents;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function fetchPodcastFeed(signal?: AbortSignal): Promise<PodcastFeed> {
  if (!configuredFeedUrl) {
    throw new Error('No rights-cleared production podcast feed is configured.');
  }
  const xml = await fetchText(configuredFeedUrl, MAX_FEED_CHARACTERS, signal);
  return parsePodcastFeed(xml, configuredFeedUrl);
}

export async function fetchEpisodeTranscript(
  episode: PodcastEpisode,
  signal?: AbortSignal,
): Promise<TranscriptCue[]> {
  const source = selectTranscriptSource(
    episode.transcriptSources.filter((candidate) => candidate.isTimed),
    'en',
  );
  if (!source || !source.isTimed) {
    throw new Error('This episode does not publish a timed transcript in its RSS feed.');
  }

  const contents = await fetchText(source.url, MAX_TRANSCRIPT_CHARACTERS, signal);
  const transcript = parseTranscript(contents, source);
  if (transcript.length === 0) {
    throw new Error('The feed transcript could not be mapped to the episode timeline.');
  }
  return transcript;
}
