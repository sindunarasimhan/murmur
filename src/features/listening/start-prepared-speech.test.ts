import assert from 'node:assert/strict';
import test from 'node:test';
import { startPreparedSpeech } from './start-prepared-speech';

test('speech waits for the replacement source before asking the native player to play', async () => {
  let loaded = false; let plays = 0;
  await startPreparedSpeech({ get isLoaded() { return loaded; }, play() { assert(loaded); plays++; } }, () => true,
    async () => { loaded = true; });
  assert.equal(plays, 1);
});
test('cancelled or replaced speech cannot start when loading finishes late', async () => {
  let active = true;
  await assert.rejects(startPreparedSpeech({ isLoaded: false, play: () => assert.fail('Stale speech started') }, () => active,
    async () => { active = false; }), { name: 'AbortError' });
});
test('an already loaded source plays once without a loading delay', async () => {
  let plays = 0;
  await startPreparedSpeech({ isLoaded: true, play: () => { plays++; } }, () => true, async () => assert.fail('Unnecessary wait'));
  assert.equal(plays, 1);
});
