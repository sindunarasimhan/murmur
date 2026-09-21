import assert from 'node:assert/strict';
import test from 'node:test';

import type { PodcastEpisode } from '@/domain/podcast';
import {
  isConfidentPodcastCandidate,
  parsePodcastSearchUtterance,
  rankPodcastCandidates,
  selectPodcastEpisode,
} from '@/server/podcast-directory/podcast-search';

function episode(title: string, description: string, publishedAt: string): PodcastEpisode {
  return {
    id: title,
    guid: title,
    podcastTitle: 'The Daily',
    title,
    description,
    publishedAt,
    audioAsset: {
      url: `https://example.com/${encodeURIComponent(title)}.mp3`,
      identityKind: 'feed-locator',
      versionId: title,
    },
    transcriptSources: [],
    adSegments: [],
  };
}

test('extracts a show and topic from a natural latest-episode request', () => {
  assert.deepEqual(
    parsePodcastSearchUtterance(
      'Play the latest episode of The Daily about the election results.',
    ),
    {
      directoryQuery: 'The Daily',
      episodeQuery: 'the election results',
      intent: 'show',
      wantsLatest: true,
    },
  );
});

test('extracts show-only and topical podcast searches', () => {
  assert.deepEqual(parsePodcastSearchUtterance('Please play the Huberman Lab podcast'), {
    directoryQuery: 'the Huberman Lab',
    intent: 'show',
    wantsLatest: false,
  });
  assert.deepEqual(
    parsePodcastSearchUtterance('Find a podcast about artificial intelligence'),
    {
      directoryQuery: 'artificial intelligence',
      episodeQuery: 'artificial intelligence',
      intent: 'topic',
      wantsLatest: false,
    },
  );
});

test('rejects adjacent show titles while retaining exact-ish and topical matches', () => {
  const joeQuery = parsePodcastSearchUtterance('joe rogan podcast');
  assert.equal(
    isConfidentPodcastCandidate(
      {
        collectionId: 1,
        title: 'The Joe Rogan AI Experience',
        feedUrl: 'https://example.com/fake',
      },
      joeQuery,
    ),
    false,
  );
  assert.equal(
    isConfidentPodcastCandidate(
      {
        collectionId: 2,
        title: 'The Joe Rogan Experience',
        author: 'Joe Rogan',
        feedUrl: 'https://example.com/official',
      },
      joeQuery,
    ),
    true,
  );
  assert.equal(
    isConfidentPodcastCandidate(
      {
        collectionId: 4,
        title: 'The Next Joe Rogan',
        author: 'Mr. R',
        feedUrl: 'https://example.com/adjacent',
      },
      joeQuery,
    ),
    false,
  );
  assert.equal(
    isConfidentPodcastCandidate(
      {
        collectionId: 3,
        title: 'Artificial Intelligence Today',
        feedUrl: 'https://example.com/topic',
      },
      parsePodcastSearchUtterance('Find a podcast about artificial intelligence'),
    ),
    true,
  );
});

test('ranks an exact show title above directory-neighbor results', () => {
  const ranked = rankPodcastCandidates(
    [
      { collectionId: 2, title: 'The Daily Zeitgeist', feedUrl: 'https://example.com/2' },
      { collectionId: 1, title: 'The Daily', feedUrl: 'https://example.com/1' },
    ],
    'The Daily',
  );
  assert.equal(ranked[0]?.title, 'The Daily');
});

test('selects a topical episode while defaulting show-only requests to the newest', () => {
  const catalog = [
    episode('A New Consumer Debt Wave', 'Buy now, pay later expands.', '2026-09-08T09:00:00Z'),
    episode('Election Results Explained', 'What voters decided.', '2026-09-07T09:00:00Z'),
  ];

  assert.equal(selectPodcastEpisode(catalog)?.title, 'A New Consumer Debt Wave');
  assert.equal(
    selectPodcastEpisode(catalog, 'the election results')?.title,
    'Election Results Explained',
  );
});
