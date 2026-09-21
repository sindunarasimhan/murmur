import type { PodcastEpisode } from '@/domain/podcast';

export type ParsedPodcastSearch = {
  directoryQuery: string;
  episodeQuery?: string;
  intent: 'show' | 'topic';
  wantsLatest: boolean;
};

export type PodcastDirectoryCandidate = {
  collectionId: number;
  title: string;
  author?: string;
  feedUrl: string;
  artworkUrl?: string;
};

const matchStopWords = new Set([
  'a',
  'an',
  'and',
  'episode',
  'for',
  'from',
  'in',
  'of',
  'on',
  'podcast',
  'show',
  'the',
  'to',
  'with',
]);

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function meaningfulTokens(value: string): string[] {
  return normalize(value)
    .split(' ')
    .filter((token) => token.length > 1 && !matchStopWords.has(token));
}

function stripVoiceLead(value: string): string {
  return value
    .trim()
    .replace(/^hey\s+murmur[,.]?\s*/i, '')
    .replace(/^(?:(?:can|could|would|will)\s+you\s+)(?:please\s+)?/i, '')
    .replace(/^(?:please|kindly)\s+/i, '')
    .replace(
      /^(?:(?:i\s+(?:want|would\s+like)\s+to)\s+)?(?:play|find|search\s+for|look\s+for|open|start|choose|select|pick|put\s+on|listen\s+to|hear)\s+/i,
      '',
    )
    .replace(/\s+please[.!?]?$/i, '')
    .replace(/[.!?]+$/g, '')
    .trim();
}

function cleanShowQuery(value: string): string {
  return value
    .replace(/^(?:the\s+)?(?:latest|newest|most\s+recent)\s+/i, '')
    .replace(/^(?:an?|some)\s+/i, '')
    .replace(/^(?:podcast|show)(?:\s+(?:called|named|titled))?\s+/i, '')
    .replace(/\s+(?:podcast|show)$/i, '')
    .trim();
}

/** Convert natural playback language into stable directory and episode terms. */
export function parsePodcastSearchUtterance(utterance: string): ParsedPodcastSearch {
  const request = stripVoiceLead(utterance);
  const wantsLatest = /\b(?:latest|newest|most\s+recent)\b/i.test(request);
  const relation = '(?:about|on|regarding|covering|featuring|with\\s+guest)';

  const genericTopic = request.match(
    /^(?:(?:an?|some)\s+)?podcasts?\s+(?:about|on|regarding|covering)\s+(.+)$/i,
  );
  if (genericTopic?.[1]) {
    const topic = genericTopic[1].trim();
    return { directoryQuery: topic, episodeQuery: topic, intent: 'topic', wantsLatest };
  }

  const episodeFromShow = request.match(
    new RegExp(
      `^(?:(?:the\\s+)?(?:latest|newest|most\\s+recent)\\s+)?(?:podcast\\s+)?episode\\s+(?:of|from)\\s+(.+?)(?:\\s+${relation}\\s+(.+))?$`,
      'i',
    ),
  );
  if (episodeFromShow?.[1]) {
    return {
      directoryQuery: cleanShowQuery(episodeFromShow[1]),
      episodeQuery: episodeFromShow[2]?.trim(),
      intent: 'show',
      wantsLatest,
    };
  }

  const showEpisode = request.match(
    new RegExp(
      `^(.+?)\\s+(?:podcast\\s+)?episode(?:\\s+${relation}\\s+(.+))?$`,
      'i',
    ),
  );
  if (showEpisode?.[1]) {
    return {
      directoryQuery: cleanShowQuery(showEpisode[1]),
      episodeQuery: showEpisode[2]?.trim(),
      intent: 'show',
      wantsLatest,
    };
  }

  const showWithTopic = request.match(
    new RegExp(`^(.+?)(?:\\s+(?:podcast|show))?\\s+${relation}\\s+(.+)$`, 'i'),
  );
  if (showWithTopic?.[1]) {
    return {
      directoryQuery: cleanShowQuery(showWithTopic[1]),
      episodeQuery: showWithTopic[2]?.trim(),
      intent: 'show',
      wantsLatest,
    };
  }

  return {
    directoryQuery: cleanShowQuery(request),
    intent: 'show',
    wantsLatest,
  };
}

/**
 * Show-title requests must not silently resolve to an adjacent or impersonator
 * podcast. Topic discovery remains intentionally broad.
 */
export function isConfidentPodcastCandidate(
  candidate: PodcastDirectoryCandidate,
  parsed: ParsedPodcastSearch,
): boolean {
  if (parsed.intent === 'topic') return true;

  const queryTokens = meaningfulTokens(parsed.directoryQuery);
  const candidateTokens = meaningfulTokens(candidate.title);
  if (queryTokens.length === 0 || candidateTokens.length === 0) return false;
  if (normalize(parsed.directoryQuery) === normalize(candidate.title)) return true;

  const sameTokens = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((token, index) => token === right[index]);
  if (sameTokens(queryTokens, candidateTokens)) return true;

  const authorTokens = meaningfulTokens(candidate.author ?? '');
  return sameTokens(queryTokens, authorTokens);
}

function phraseScore(query: string, candidate: string): number {
  const normalizedQuery = normalize(query);
  const normalizedCandidate = normalize(candidate);
  if (!normalizedQuery || !normalizedCandidate) return 0;
  if (normalizedQuery === normalizedCandidate) return 120;

  let score = 0;
  if (
    normalizedCandidate.includes(normalizedQuery) ||
    normalizedQuery.includes(normalizedCandidate)
  ) {
    score += 55;
  }

  const queryTokens = meaningfulTokens(query);
  const candidateTokens = new Set(meaningfulTokens(candidate));
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) score += 14;
  }
  if (queryTokens.length > 0 && queryTokens.every((token) => candidateTokens.has(token))) {
    score += 30;
  }
  return score;
}

export function rankPodcastCandidates(
  candidates: readonly PodcastDirectoryCandidate[],
  directoryQuery: string,
): PodcastDirectoryCandidate[] {
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score:
        phraseScore(directoryQuery, candidate.title) +
        phraseScore(directoryQuery, candidate.author ?? '') * 0.2,
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ candidate }) => candidate);
}

function publishedTime(episode: PodcastEpisode): number {
  if (!episode.publishedAt) return 0;
  const time = Date.parse(episode.publishedAt);
  return Number.isFinite(time) ? time : 0;
}

export function selectPodcastEpisode(
  episodes: readonly PodcastEpisode[],
  episodeQuery?: string,
): PodcastEpisode | undefined {
  if (episodes.length === 0) return undefined;
  if (!episodeQuery?.trim()) {
    return [...episodes].sort((left, right) => publishedTime(right) - publishedTime(left))[0];
  }

  return episodes
    .map((episode, index) => ({
      episode,
      index,
      score:
        phraseScore(episodeQuery, episode.title) * 3 +
        phraseScore(episodeQuery, episode.description),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        publishedTime(right.episode) - publishedTime(left.episode) ||
        left.index - right.index,
    )[0]?.episode;
}
