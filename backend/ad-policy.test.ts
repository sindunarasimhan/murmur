import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAd } from './ad-policy';
import { FOCUS_AUDIO_SHA } from './focus-episode';
const marker = { id: 'workos', startSeconds: 2230, endSeconds: 2290, audioVersion: FOCUS_AUDIO_SHA, source: 'audio-review' };
const key = `${FOCUS_AUDIO_SHA}.mp3`;
test('Brian’s skip is bounded to the reviewed ad and never seeks the next ad', () => {
  for (const position of [0, 2229.999, 2290, 2290.001, 4477]) assert.equal(resolveAd(position, 4477, FOCUS_AUDIO_SHA, [marker], key).kind, 'outside-ad');
  for (const position of [2230, 2250.375, 2289.999]) {
    const result = resolveAd(position, 4477, FOCUS_AUDIO_SHA, [marker], key);
    assert.equal(result.kind, 'skip'); if (result.kind === 'skip') assert.equal(result.ad.endSeconds, 2290);
  }
});
test('changed audio, ambiguous or malformed intervals and transcript-only evidence cannot trigger skips', () => {
  for (const markers of [[{ ...marker, audioVersion: 'b'.repeat(64) }], [{ ...marker, endSeconds: 5000 }], [{ ...marker, endSeconds: 2220 }], [marker, { ...marker, id: 'overlap' }], [{ ...marker, source: 'reviewed-transcript' }], [], null]) {
    assert.equal(resolveAd(2250, 4477, FOCUS_AUDIO_SHA, markers, key).kind, 'unverified');
  }
  assert.equal(resolveAd(2250, 4477, FOCUS_AUDIO_SHA, [marker], null).kind, 'unverified');
  assert.equal(resolveAd(2250, 4477, FOCUS_AUDIO_SHA, [marker], `${'b'.repeat(64)}.mp3`).kind, 'unverified');
});
