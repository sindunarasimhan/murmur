import { SERVER_BUDGETS } from '../config';
import { ApiError } from '../http/api';
import { isRecord, readUpstreamBytes, readUpstreamJson, requestUpstream, UpstreamError, withDeadline } from '../http/upstream';
import type { PodcastDirectoryCandidate } from './podcast-search';
import { parsePublicHttpsUrl } from './public-url';
import { parsePodcastFeed } from '@/services/rss/parse-podcast-feed';
import type { PodcastFeed } from '@/domain/podcast';

type Options = { fetch?: typeof fetch; signal: AbortSignal };

function parseCandidates(payload: unknown): PodcastDirectoryCandidate[] {
  if (!isRecord(payload) || !Array.isArray(payload.results)) throw new UpstreamError('invalid');
  return payload.results.slice(0, 12).flatMap((result) => {
    if (!isRecord(result)) return [];
    const feedUrl = parsePublicHttpsUrl(result.feedUrl);
    if (!feedUrl || typeof result.collectionId !== 'number' || !Number.isSafeInteger(result.collectionId) ||
        result.collectionId <= 0 || typeof result.collectionName !== 'string' || !result.collectionName.trim()) return [];
    return [{
      collectionId: result.collectionId, title: result.collectionName.trim(), feedUrl: feedUrl.toString(),
      author: typeof result.artistName === 'string' ? result.artistName.trim() || undefined : undefined,
      artworkUrl: parsePublicHttpsUrl(result.artworkUrl600)?.toString(),
    }];
  });
}

export async function searchDirectory(query: string, options: Options): Promise<PodcastDirectoryCandidate[]> {
  const url = new URL('https://itunes.apple.com/search');
  url.search = new URLSearchParams({ country: 'US', media: 'podcast', entity: 'podcast', limit: '12', term: query }).toString();
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestUpstream(url.toString(), { headers: { Accept: 'application/json' } },
        { ...options, timeoutMs: SERVER_BUDGETS.directory }, async (response, signal) =>
          parseCandidates(await readUpstreamJson(response, 512 * 1024, signal)));
    } catch (error) {
      if (options.signal.aborted || (error instanceof UpstreamError && error.kind === 'cancelled')) throw new UpstreamError('cancelled');
      // Only this free, idempotent lookup retries once. Never immediately retry a rate limit.
      const transient = error instanceof UpstreamError &&
        (error.kind === 'timeout' || (error.kind === 'unavailable' && error.status !== 429));
      if (attempt === 0 && transient) continue;
      throw new ApiError(503, 'directory_unavailable', 'Podcast search is temporarily unavailable.', transient ||
        (error instanceof UpstreamError && error.status === 429));
    }
  }
}

export async function loadPodcastFeed(initialUrl: string, options: Options): Promise<PodcastFeed> {
  return withDeadline(options.signal, SERVER_BUDGETS.feed, async (signal) => {
    let current = parsePublicHttpsUrl(initialUrl);
    if (!current) throw new UpstreamError('invalid');
    for (let redirect = 0; redirect <= 4; redirect += 1) {
      const feedUrl = current.toString();
      const result: { next?: URL; feed?: PodcastFeed } = await requestUpstream(feedUrl, {
        redirect: 'manual',
        headers: { Accept: 'application/rss+xml, application/xml, text/xml;q=0.9', 'User-Agent': 'MurmurPodcastClient/0.1' },
      }, { ...options, signal, timeoutMs: SERVER_BUDGETS.feed, allowRedirect: true }, async (response, bodySignal) => {
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          const next = parsePublicHttpsUrl(location ? new URL(location, feedUrl).toString() : undefined);
          if (!next) throw new UpstreamError('invalid');
          return { next };
        }
        const bytes = await readUpstreamBytes(response, 10 * 1024 * 1024, bodySignal);
        return { feed: parsePodcastFeed(new TextDecoder().decode(bytes), feedUrl) };
      });
      if (result.feed) return result.feed;
      current = result.next;
      if (!current) break;
    }
    throw new UpstreamError('invalid');
  });
}
