import assert from 'node:assert/strict';
import test from 'node:test';

import type { PodcastEpisode } from '@/domain/podcast';
import { buildContextualAnswer } from '@/services/exploration/build-contextual-answer';

const episode: PodcastEpisode = {
  id: 'episode-1',
  guid: 'episode-1',
  podcastTitle: 'Open Audio',
  title: 'Why timed transcripts matter',
  description: 'A conversation about transcript metadata.',
  audioAsset: {
    url: 'https://example.com/audio.mp3',
    identityKind: 'feed-locator',
    versionId: 'asset-1',
  },
  transcriptSources: [],
  transcript: [
    { id: 'one', startSeconds: 10, endSeconds: 14, text: 'The transcript follows the audio.' },
  ],
  adSegments: [],
};

test('grounds a clarification in the nearby timed transcript', () => {
  const answer = buildContextualAnswer({
    category: 'clarify',
    episode,
    positionSeconds: 12,
    transcript: episode.transcript ?? [],
    utterance: 'What does that mean?',
  });

  assert.match(answer, /The transcript follows the audio/);
  assert.match(answer, /maps words to moments/);
});

test('does not pretend local transcript context is external fact verification', () => {
  const answer = buildContextualAnswer({
    category: 'factual',
    episode,
    positionSeconds: 12,
    transcript: episode.transcript ?? [],
    utterance: 'Is that claim true?',
  });

  assert.match(answer, /not connected to outside evidence yet/);
});

test('labels broad transcript cues as section-level context instead of quoting them precisely', () => {
  const answer = buildContextualAnswer({
    category: 'clarify',
    episode,
    positionSeconds: 35,
    transcript: [
      {
        id: 'broad',
        startSeconds: 0,
        endSeconds: 90,
        text: 'A long section that is not aligned word by word.',
      },
    ],
    utterance: 'Explain this section.',
  });

  assert.match(answer, /section-level—not word-level—context/);
  assert.doesNotMatch(answer, /episode says/);
});

test('carries the previous exploration answer into a follow-up', () => {
  const answer = buildContextualAnswer({
    category: 'debate',
    episode,
    positionSeconds: 12,
    priorTurns: [
      {
        question: 'How does publisher control affect open metadata?',
        answer: 'The first answer centered publisher control and open metadata.',
      },
    ],
    transcript: episode.transcript ?? [],
    utterance: 'Challenge that.',
  });

  assert.match(answer, /promise and limits of open metadata/);
  assert.match(answer, /test that framing directly/);
});
