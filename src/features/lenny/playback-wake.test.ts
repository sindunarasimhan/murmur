import assert from 'node:assert/strict';
import test from 'node:test';
import { PlaybackWake } from './playback-wake';

test('playback wake accepts punctuation without altering the original display or command', () => {
  const wake = new PlaybackWake();
  for (const punctuation of ['.', '!', '?', '—', ',', ' ']) {
    const text = `Hey${punctuation} Murmur, pause please`;
    assert.deepEqual(wake.receive(text, punctuation), { request: 'pause please', display: text });
  }
});
test('adjacent items assemble a wake and preserve growing snapshots through a delayed final', () => {
  let now = 0;
  const wake = new PlaybackWake(() => now);
  assert.equal(wake.receive('Hey.', 'a'), undefined);
  assert.deepEqual(wake.receive('Murmur', 'b'), { request: '', display: 'Hey. Murmur' });
  now = 5000;
  assert.deepEqual(wake.receive('Murmur, pause', 'b'), { request: 'pause', display: 'Hey. Murmur, pause' });
  assert.deepEqual(wake.receive('Murmur, pause', 'b'), { request: 'pause', display: 'Hey. Murmur, pause' });
});
test('a full snapshot replaces the carry rather than duplicating it', () => {
  const wake = new PlaybackWake();
  wake.receive('Hey', 'a');
  assert.deepEqual(wake.receive('Hey! Murmur pause', 'a'), { request: 'pause', display: 'Hey! Murmur pause' });
});
test('prefix expires, and duplicate prefix snapshots do not extend its lifetime', () => {
  let now = 0;
  const wake = new PlaybackWake(() => now);
  wake.receive('Hey', 'a'); now = 1500; wake.receive('Hey', 'a'); now = 2001;
  assert.equal(wake.receive('Murmur pause', 'b'), undefined);
});
test('intervening content invalidates prefix instead of joining arbitrary transcript history', () => {
  const wake = new PlaybackWake();
  wake.receive('Hey', 'a'); wake.receive('This is a podcast', 'b');
  assert.equal(wake.receive('Murmur pause', 'c'), undefined);
  wake.receive('They said hey', 'd');
  assert.equal(wake.receive('Murmur pause', 'e'), undefined);
});
test('older received item cannot replace the latest prefix or replay an old command', () => {
  const wake = new PlaybackWake();
  wake.receive('Hey', 'a'); wake.receive('Not a wake', 'b');
  assert.equal(wake.receive('Hey Murmur pause', 'a'), undefined);
  assert.equal(wake.receive('Murmur pause', 'c'), undefined);
});
test('reset drops both a prefix and an already assembled continuation', () => {
  const wake = new PlaybackWake();
  wake.receive('Hey', 'a'); wake.reset();
  assert.equal(wake.receive('Murmur pause', 'b'), undefined);
  wake.receive('Hey', 'c'); wake.receive('Murmur', 'd'); wake.reset();
  assert.equal(wake.receive('Murmur pause', 'd'), undefined);
});
