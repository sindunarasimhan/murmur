import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveDiscoveryVoiceSelection,
  type DiscoveryVoiceResolution,
} from '@/domain/discovery-voice-resolver';
import type { CatalogEpisode } from '@/domain/podcast';

function episode(
  id: string,
  title: string,
  podcastTitle = 'Podcasting 2.0 in Practice',
): CatalogEpisode {
  return {
    id,
    guid: `${id}-guid`,
    podcastTitle,
    title,
    description: `${title} description`,
    audioAsset: {
      url: `https://example.com/${id}.mp3`,
      identityKind: 'content-hash',
      versionId: `${id}-v1`,
    },
    transcriptSources: [],
    adSegments: [],
    accent: '#ffffff',
    accentSoft: '#111111',
    eyebrow: 'For your curiosity',
  };
}

const catalog = [
  episode('wallets', 'Wallets Update: Holiday Homework'),
  episode('boosts', 'Boosts Update: Holiday Homework', 'Signal School'),
  episode('identity', 'Digital Identity Beyond Passwords', 'Future Proof'),
  episode('networks', 'Networks and Neighborhoods', 'City Signals'),
  episode('memory', 'How Memory Changes', 'Inner Worlds'),
  episode('markets', 'The Shape of New Markets', 'Field Notes'),
  episode('oceans', 'Listening Below the Ocean', 'Blue Planet'),
  episode('craft', 'The Craft of Good Questions', 'Field Guide'),
] as const;

function resolve(
  utterance: string,
  episodes: readonly CatalogEpisode[] = catalog,
  focusedEpisodeId?: string,
): DiscoveryVoiceResolution {
  return resolveDiscoveryVoiceSelection({
    utterance,
    episodes,
    focusedEpisodeId,
  });
}

test('matches exact episode titles through an explicit play request', () => {
  assert.deepEqual(resolve('Play Wallets Update: Holiday Homework!'), {
    kind: 'match',
    episode: catalog[0],
    reason: 'episode-title',
  });
});

test('matches a strong contiguous episode-title phrase', () => {
  assert.deepEqual(resolve('play Wallets Update'), {
    kind: 'match',
    episode: catalog[0],
    reason: 'episode-title',
  });
});

test('matches a unique podcast title', () => {
  assert.deepEqual(resolve('Could you please play the podcast Future Proof?'), {
    kind: 'match',
    episode: catalog[2],
    reason: 'podcast-title',
  });
});

test('uses the focused episode for deictic requests', () => {
  assert.deepEqual(resolve('Play this one.', catalog, 'identity'), {
    kind: 'match',
    episode: catalog[2],
    reason: 'deictic',
  });
});

test('uses the first catalog episode when a focused episode is unavailable', () => {
  assert.deepEqual(resolve('choose that one', catalog, 'not-in-catalog'), {
    kind: 'match',
    episode: catalog[0],
    reason: 'deictic',
  });
});

test('resolves word, numeric, and numbered ordinals in display order', () => {
  assert.deepEqual(resolve('play the first one'), {
    kind: 'match',
    episode: catalog[0],
    reason: 'ordinal',
  });
  assert.deepEqual(resolve('choose 3rd episode'), {
    kind: 'match',
    episode: catalog[2],
    reason: 'ordinal',
  });
  assert.deepEqual(resolve('play number 8'), {
    kind: 'match',
    episode: catalog[7],
    reason: 'ordinal',
  });
  assert.deepEqual(resolve('episode number two'), {
    kind: 'match',
    episode: catalog[1],
    reason: 'ordinal',
  });
});

test('returns no match when an ordinal is outside the available catalog', () => {
  assert.deepEqual(resolve('play the eighth one', catalog.slice(0, 3)), {
    kind: 'no-match',
  });
});

test('keeps surprise selection pure and deterministic', () => {
  assert.deepEqual(resolve('Surprise me!', catalog, 'markets'), {
    kind: 'match',
    episode: catalog[5],
    reason: 'surprise',
  });
  assert.deepEqual(resolve('pick for me', catalog), {
    kind: 'match',
    episode: catalog[0],
    reason: 'surprise',
  });
});

test('rejects weak single-token partial title matches', () => {
  assert.deepEqual(resolve('play update'), { kind: 'no-match' });
  assert.deepEqual(resolve('play holiday'), { kind: 'no-match' });
  assert.deepEqual(resolve('play podcasting'), { kind: 'no-match' });
});

test('returns ambiguity rather than guessing between episode titles', () => {
  const episodes = [
    episode('wallets-one', 'Wallets Update: Holiday Homework', 'One'),
    episode('wallets-two', 'Wallets Update: Summer School', 'Two'),
  ];

  assert.deepEqual(resolve('play Wallets Update', episodes), {
    kind: 'ambiguous',
    episodes,
  });
});

test('returns ambiguity when a podcast title identifies multiple episodes', () => {
  const episodes = [
    episode('field-one', 'A Walk Outside', 'Field Notes'),
    episode('field-two', 'A Walk Inside', 'Field Notes'),
  ];

  assert.deepEqual(resolve('listen to Field Notes', episodes), {
    kind: 'ambiguous',
    episodes,
  });
});

test('does not infer selection from conversational or empty input', () => {
  assert.deepEqual(resolve('Tell me about the wallets update'), {
    kind: 'no-match',
  });
  assert.deepEqual(resolve('play this one', []), { kind: 'no-match' });
  assert.deepEqual(resolve('  '), { kind: 'no-match' });
});
