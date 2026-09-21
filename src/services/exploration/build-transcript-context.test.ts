import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildEpisodeMetadataContext,
  buildTranscriptContext,
} from '@/services/exploration/build-transcript-context';

test('formats only the transcript window around the saved playback position', () => {
  const context = buildTranscriptContext(
    [
      { id: 'old', startSeconds: 0, endSeconds: 4, text: 'Too far behind.' },
      {
        id: 'near',
        startSeconds: 80,
        endSeconds: 86,
        speaker: 'Host',
        text: '  The nearby\nidea. ',
      },
      { id: 'future', startSeconds: 140, endSeconds: 144, text: 'Too far ahead.' },
    ],
    90,
  );

  assert.equal(context, '[1:20–1:26; timed cue] Host: The nearby idea.');
});

test('labels coarse publisher transcript sections without implying word-level alignment', () => {
  const context = buildTranscriptContext(
    [{ id: 'broad', startSeconds: 0, endSeconds: 90, text: 'Broad context.' }],
    45,
  );

  assert.match(context, /section timing/);
});

test('bounds transcript context sent to the backend', () => {
  const transcript = Array.from({ length: 70 }, (_, index) => ({
    id: String(index),
    startSeconds: index,
    endSeconds: index + 1,
    text: `cue-${index} ${'x'.repeat(500)}`,
  }));

  const context = buildTranscriptContext(transcript, 60);
  assert.ok(context.length <= 12_000);
  assert.match(context, /cue-60/);
});

test('builds an honest metadata fallback when a feed has no timed transcript', () => {
  const context = buildEpisodeMetadataContext(
    {
      podcastTitle: 'The Joe Rogan Experience',
      title: '#2550 - Rick Springfield',
      description: 'Rick Springfield is a musician and actor.',
    },
    92,
  );

  assert.match(context, /episode metadata only/i);
  assert.match(context, /Do not claim or quote what was said/i);
  assert.match(context, /Playback position: 1:32/);
  assert.match(context, /Rick Springfield is a musician and actor/);
});
