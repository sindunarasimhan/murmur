import assert from 'node:assert/strict';
import test from 'node:test';

import { EXPLORE_LIMITS } from './explore-contract';
import { validateExploreRequest } from './explore-validation';

const validRequest = {
  question: '  What\u0000 does   that mean?  ',
  intent: 'clarify',
  episode: { title: 'Episode one', showTitle: 'The Show' },
  playbackPositionSeconds: 42.5,
  transcriptContext: ' First  line. \r\n\r\n Second   line. ',
  history: [{ question: ' Earlier? ', answer: ' An earlier answer. ' }],
};

test('validates and sanitizes a complete explore request', () => {
  const result = validateExploreRequest(validRequest);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.question, 'What does that mean?');
  assert.equal(result.value.transcriptContext, 'First line.\nSecond line.');
  assert.deepEqual(result.value.history, [
    { question: 'Earlier?', answer: 'An earlier answer.' },
  ]);
});

test('rejects unsupported intents and unexpected fields', () => {
  assert.deepEqual(
    validateExploreRequest({ ...validRequest, intent: 'command' }),
    { ok: false, message: 'intent is not supported.' },
  );
  assert.deepEqual(
    validateExploreRequest({ ...validRequest, secret: 'not allowed' }),
    { ok: false, message: 'Request body contains an unexpected field.' },
  );
});

test('rejects oversized transcript context and history', () => {
  const longTranscript = 'x'.repeat(
    EXPLORE_LIMITS.transcriptContextCharacters + 1,
  );
  const transcriptResult = validateExploreRequest({
    ...validRequest,
    transcriptContext: longTranscript,
  });
  assert.equal(transcriptResult.ok, false);

  const historyResult = validateExploreRequest({
    ...validRequest,
    history: Array.from(
      { length: EXPLORE_LIMITS.historyTurns + 1 },
      () => ({ question: 'q', answer: 'a' }),
    ),
  });
  assert.equal(historyResult.ok, false);
});

test('rejects non-finite and implausible playback positions', () => {
  for (const playbackPositionSeconds of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    EXPLORE_LIMITS.playbackPositionSeconds + 1,
  ]) {
    const result = validateExploreRequest({
      ...validRequest,
      playbackPositionSeconds,
    });
    assert.equal(result.ok, false);
  }
});
