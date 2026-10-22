import assert from 'node:assert/strict';
import test from 'node:test';
import { preservePlayback } from './preserve-playback';
import { PLAYBACK_AUDIO_MODE, RECORDING_AUDIO_MODE } from '../listening/audio-mode';

test('audio modes allow podcast background playback but never background recording', () => {
  for (const mode of [PLAYBACK_AUDIO_MODE, RECORDING_AUDIO_MODE]) {
    assert.equal(mode.shouldPlayInBackground, true);
    assert.equal(mode.allowsBackgroundRecording, false);
    assert.equal(mode.interruptionMode, 'doNotMix');
  }
  assert.equal(PLAYBACK_AUDIO_MODE.allowsRecording, false);
});
for (const playing of [true, false]) {
  test(`audio-session transition preserves ${playing ? 'playing' : 'paused'} without seeking`, async () => {
    let resumed = 0;
    const player = { playing, play() { this.playing = true; resumed++; } };
    await preservePlayback(player, async () => { player.playing = false; }, () => true);
    assert.equal(player.playing, playing); assert.equal(resumed, playing ? 1 : 0);
  });
}
test('late capture cleanup cannot restart a disposed or superseded player', async () => {
  const player = { playing: true, play() { assert.fail('Stale player resumed'); } };
  await preservePlayback(player, async () => { player.playing = false; }, () => false);
});
test('capture startup failure still restores podcast playback and reports the failure', async () => {
  const player = { playing: true, play() { this.playing = true; } };
  await assert.rejects(preservePlayback(player, async () => {
    player.playing = false; throw new Error('Capture failed');
  }, () => true), /Capture failed/);
  assert(player.playing);
});
