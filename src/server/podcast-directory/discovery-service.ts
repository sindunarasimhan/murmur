import type { PodcastSearchResult } from '@/domain/podcast-search';
import { SERVER_BUDGETS } from '../config';
import { ApiError } from '../http/api';
import { UpstreamError, withDeadline } from '../http/upstream';
import { loadPodcastFeed, searchDirectory } from './directory-provider';
import { isConfidentPodcastCandidate, parsePodcastSearchUtterance, rankPodcastCandidates, selectPodcastEpisode } from './podcast-search';

export async function discoverEpisode(utterance: string, options: {
  fetch?: typeof fetch; signal: AbortSignal; timeoutMs?: number;
}): Promise<PodcastSearchResult> {
  const parsed = parsePodcastSearchUtterance(utterance);
  if (!parsed.directoryQuery) throw new ApiError(400, 'invalid_query', 'Say a podcast title, host, or topic to search.');
  return withDeadline(options.signal, options.timeoutMs ?? SERVER_BUDGETS.discovery, async (signal) => {
    const ranked = rankPodcastCandidates(await searchDirectory(parsed.directoryQuery, { ...options, signal }), parsed.directoryQuery);
    if (!ranked.length) throw new ApiError(404, 'podcast_not_found', 'I could not find that podcast.');
    const candidates = ranked.filter(candidate => isConfidentPodcastCandidate(candidate, parsed));
    if (!candidates.length) throw new ApiError(404, 'public_feed_unavailable', 'I could not find a verified public RSS feed for that podcast.');
    let feedFailure = false;
    for (const candidate of candidates.slice(0, 4)) {
      signal.throwIfAborted();
      let feed;
      try { feed = await loadPodcastFeed(candidate.feedUrl, { ...options, signal }); }
      catch (error) {
        if (signal.aborted || (error instanceof UpstreamError && error.kind === 'cancelled')) throw new UpstreamError('cancelled');
        feedFailure = true;
        continue;
      }
      const selected = selectPodcastEpisode(feed.episodes, parsed.episodeQuery);
      if (!selected) continue;
      return {
        provider: 'apple-podcasts-rss',
        query: { directory: parsed.directoryQuery, episode: parsed.episodeQuery, wantsLatest: parsed.wantsLatest },
        podcast: {
          directoryId: String(candidate.collectionId), title: feed.title || candidate.title,
          author: feed.author ?? candidate.author, feedUrl: feed.feedUrl,
          artworkUrl: feed.artworkUrl ?? candidate.artworkUrl,
        },
        episode: { ...selected, artworkUrl: selected.artworkUrl ?? feed.artworkUrl ?? candidate.artworkUrl },
      };
    }
    throw new ApiError(feedFailure ? 502 : 404, feedFailure ? 'feed_unavailable' : 'episode_not_found',
      feedFailure ? 'The podcast was found, but its RSS feed could not be loaded.' : 'The podcast feed has no playable episodes.', feedFailure);
  });
}
