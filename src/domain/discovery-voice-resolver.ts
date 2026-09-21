import type { CatalogEpisode } from '@/domain/podcast';

export type DiscoveryVoiceMatchReason =
  | 'deictic'
  | 'episode-title'
  | 'ordinal'
  | 'podcast-title'
  | 'surprise';

export type DiscoveryVoiceResolution =
  | {
      kind: 'match';
      episode: CatalogEpisode;
      reason: DiscoveryVoiceMatchReason;
    }
  | {
      kind: 'ambiguous';
      episodes: CatalogEpisode[];
    }
  | { kind: 'no-match' };

export type ResolveDiscoveryVoiceSelectionInput = {
  utterance: string;
  episodes: readonly CatalogEpisode[];
  focusedEpisodeId?: string;
};

const ordinalIndexes: Readonly<Record<string, number>> = {
  first: 0,
  '1st': 0,
  second: 1,
  '2nd': 1,
  third: 2,
  '3rd': 2,
  fourth: 3,
  '4th': 3,
  fifth: 4,
  '5th': 4,
  sixth: 5,
  '6th': 5,
  seventh: 6,
  '7th': 6,
  eighth: 7,
  '8th': 7,
};

const numberedIndexes: Readonly<Record<string, number>> = {
  one: 0,
  two: 1,
  three: 2,
  four: 3,
  five: 4,
  six: 5,
  seven: 6,
  eight: 7,
};

const weakTitleWords = new Set([
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

function unwrapCourtesy(value: string): string {
  return value
    .replace(/^(?:(?:can|could|would|will) you )(?:please )?/, '')
    .replace(/^(?:please|kindly) /, '')
    .replace(/ please$/, '')
    .trim();
}

function defaultEpisode(
  episodes: readonly CatalogEpisode[],
  focusedEpisodeId: string | undefined,
): CatalogEpisode | undefined {
  return (
    episodes.find((episode) => episode.id === focusedEpisodeId) ?? episodes[0]
  );
}

function ordinalIndex(request: string): number | undefined {
  const ordinalMatch = request.match(
    /^(?:(?:play|choose|select|pick|open|start|listen to|put on) )?(?:the )?(first|second|third|fourth|fifth|sixth|seventh|eighth|1st|2nd|3rd|4th|5th|6th|7th|8th)(?: (?:one|episode|podcast|show))?$/,
  );
  const ordinal = ordinalMatch?.[1];
  if (ordinal) return ordinalIndexes[ordinal];

  const numberedMatch = request.match(
    /^(?:(?:play|choose|select|pick|open|start|listen to|put on) )?(?:(?:the )?(?:episode|podcast|show) )?number ([1-8]|one|two|three|four|five|six|seven|eight)$/,
  );
  const numbered = numberedMatch?.[1];
  if (!numbered) return undefined;

  const numericIndex = Number(numbered) - 1;
  return Number.isInteger(numericIndex) ? numericIndex : numberedIndexes[numbered];
}

function titleCandidates(request: string): string[] {
  const commandMatch = request.match(
    /^(?:play|choose|select|pick|open|start|listen to|put on) (.+)$/,
  );
  const subject = commandMatch?.[1] ?? request;
  const candidates = [subject];

  const withoutMediaLabel = subject.replace(
    /^(?:the )?(?:(?:podcast )?episode|podcast|show)(?: called| named| titled)? /,
    '',
  );
  if (withoutMediaLabel !== subject) candidates.push(withoutMediaLabel);

  const withoutArticle = subject.replace(/^the /, '');
  if (withoutArticle !== subject) candidates.push(withoutArticle);

  return [...new Set(candidates.filter(Boolean))];
}

function isStrongPartialTitle(candidate: string, title: string): boolean {
  const candidateTokens = candidate.split(' ');
  const meaningfulCandidateTokens = candidateTokens.filter(
    (token) => !weakTitleWords.has(token),
  );

  if (meaningfulCandidateTokens.length < 2 || candidate.length < 8) {
    return false;
  }

  const paddedTitle = ` ${title} `;
  if (!paddedTitle.includes(` ${candidate} `)) return false;

  const meaningfulTitleTokens = title
    .split(' ')
    .filter((token) => !weakTitleWords.has(token));

  return (
    meaningfulCandidateTokens.length >= 3 ||
    meaningfulCandidateTokens.length / meaningfulTitleTokens.length >= 0.5
  );
}

function matchingEpisodes(
  episodes: readonly CatalogEpisode[],
  candidates: readonly string[],
  field: 'podcastTitle' | 'title',
  exact: boolean,
): CatalogEpisode[] {
  return episodes.filter((episode) => {
    const title = normalize(episode[field]);
    return candidates.some((candidate) =>
      exact ? candidate === title : isStrongPartialTitle(candidate, title),
    );
  });
}

function uniqueEpisodes(
  episodes: readonly CatalogEpisode[],
): CatalogEpisode[] {
  const seenIds = new Set<string>();
  return episodes.filter((episode) => {
    if (seenIds.has(episode.id)) return false;
    seenIds.add(episode.id);
    return true;
  });
}

function resolveTitleReference(
  request: string,
  episodes: readonly CatalogEpisode[],
): DiscoveryVoiceResolution {
  const candidates = titleCandidates(request);

  for (const exact of [true, false]) {
    const episodeTitleMatches = matchingEpisodes(
      episodes,
      candidates,
      'title',
      exact,
    );
    const podcastTitleMatches = matchingEpisodes(
      episodes,
      candidates,
      'podcastTitle',
      exact,
    );
    const matches = uniqueEpisodes([
      ...episodeTitleMatches,
      ...podcastTitleMatches,
    ]);

    if (matches.length > 1) {
      return { kind: 'ambiguous', episodes: matches };
    }

    const episode = matches[0];
    if (episode) {
      return {
        kind: 'match',
        episode,
        reason: episodeTitleMatches.includes(episode)
          ? 'episode-title'
          : 'podcast-title',
      };
    }
  }

  return { kind: 'no-match' };
}

/**
 * Resolves a small, explicit discovery vocabulary without guessing at intent.
 * The catalog order is the display order and therefore defines ordinal and
 * deterministic default selections.
 */
export function resolveDiscoveryVoiceSelection({
  utterance,
  episodes,
  focusedEpisodeId,
}: ResolveDiscoveryVoiceSelectionInput): DiscoveryVoiceResolution {
  const request = unwrapCourtesy(normalize(utterance));
  if (!request || episodes.length === 0) return { kind: 'no-match' };

  if (
    /^(?:(?:play|choose|select|pick|open|start|listen to|put on) )?(?:this|that) one$/.test(
      request,
    )
  ) {
    const episode = defaultEpisode(episodes, focusedEpisodeId);
    return episode
      ? { kind: 'match', episode, reason: 'deictic' }
      : { kind: 'no-match' };
  }

  if (/^(?:pick for me|surprise me)$/.test(request)) {
    const episode = defaultEpisode(episodes, focusedEpisodeId);
    return episode
      ? { kind: 'match', episode, reason: 'surprise' }
      : { kind: 'no-match' };
  }

  const index = ordinalIndex(request);
  if (index !== undefined) {
    const episode = episodes[index];
    return episode
      ? { kind: 'match', episode, reason: 'ordinal' }
      : { kind: 'no-match' };
  }

  return resolveTitleReference(request, episodes);
}
