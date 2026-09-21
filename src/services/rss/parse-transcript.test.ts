import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTranscript, transcriptWindow } from './parse-transcript';

test('parses WebVTT cues and returns a playback window', () => {
  const cues = parseTranscript(
    `WEBVTT

00:00:10.000 --> 00:00:13.500
<v Host>What does attention make possible?

00:00:14.000 --> 00:00:18.000
It lets an idea remain in motion.`,
    { kind: 'vtt' },
  );

  assert.equal(cues.length, 2);
  assert.equal(cues[0]?.startSeconds, 10);
  assert.equal(cues[0]?.text, 'Host: What does attention make possible?');
  assert.deepEqual(transcriptWindow(cues, 15, 2, 1).map((cue) => cue.id), [cues[0]?.id, cues[1]?.id]);
});

test('parses a common timestamped JSON transcript shape', () => {
  const cues = parseTranscript(
    JSON.stringify({
      segments: [
        { startTime: 3, endTime: 6.5, speaker: 'Guest', body: 'Flow preserves context.' },
      ],
    }),
    { kind: 'json' },
  );

  assert.equal(cues[0]?.speaker, 'Guest');
  assert.equal(cues[0]?.endSeconds, 6.5);
  assert.equal(cues[0]?.text, 'Flow preserves context.');
});

test('decodes safe named and numeric entities in timed transcript cues', () => {
  const cues = parseTranscript(
    `WEBVTT

00:00:01.000 --> 00:00:03.000
Research &amp; debate &#x2014; then clarify.`,
    { kind: 'vtt' },
  );

  assert.equal(cues[0]?.text, 'Research & debate — then clarify.');
});
