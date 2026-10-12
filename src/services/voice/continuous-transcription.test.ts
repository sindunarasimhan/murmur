import assert from 'node:assert/strict';
import test from 'node:test';
import { ContinuousTranscription } from './continuous-transcription';
import type { WebSocketLike } from './realtime-transcription';

function fixture(options: { semantic?: boolean; requireSemantic?: boolean } = {}) {
  const sent: string[] = []; const partials: string[] = []; const finals: string[] = []; const errors: Error[] = []; let starts = 0; let stops = 0; let activity = 0;
  let stopped = false;
  const socket: WebSocketLike = {
    readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
    send: (data) => { sent.push(data); }, close: () => { stopped = true; },
  };
  const client = new ContinuousTranscription({
    url: () => 'ws://localhost/v2/live-voice', ticket: async () => ({ token: 'single-use-murmur-ticket', leaseMilliseconds: 840_000 }),
    semanticTurnDetection: options.semantic,
    requireSemanticTurnDetection: options.requireSemantic,
    socket: (_url, protocols) => {
      assert.deepEqual(protocols, ['murmur-ticket.single-use-murmur-ticket', ...(options.semantic ? ['murmur-semantic-v1'] : [])]);
      return socket;
    },
    callbacks: { partial: (text) => partials.push(text), final: (text) => finals.push(text), activity: () => { activity++; }, speechStarted: () => { starts++; }, speechStopped: () => { stops++; }, error: (error) => errors.push(error) },
  });
  const emit = (value: unknown) => socket.onmessage?.({ data: JSON.stringify(value) });
  return { client, socket, sent, partials, finals, errors, emit, get starts() { return starts; }, get stops() { return stops; }, get activity() { return activity; }, get stopped() { return stopped; } };
}
test('continuous transport accepts multiple turns, normalizes PCM, and stops all work on shutdown', async () => {
  const f = fixture();
  const pending = f.client.start(); await Promise.resolve(); f.emit({ type: 'ready' }); await pending;
  try {
    f.client.append(new Int16Array(4800).buffer, 48_000, 1); f.client.commit();
    assert.equal(Buffer.from(JSON.parse(f.sent[0]!).audio, 'base64').length, 4800);
    f.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'one', delta: 'Hey ' });
    f.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'one', delta: 'Murmur' });
    f.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'one', transcript: 'Hey Murmur' });
    f.client.append(new Int16Array(2400).buffer, 24_000, 1); f.client.commit();
    f.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'two', transcript: 'Play Lenny' });
    assert.deepEqual(f.partials, ['Hey ', 'Hey Murmur']); assert.deepEqual(f.finals, ['Hey Murmur', 'Play Lenny']);
    const before = f.sent.length; f.client.stop();
    f.client.append(new Int16Array(2400).buffer, 24_000, 1);
    assert(f.stopped); assert.equal(f.sent.length, before); assert.equal(f.socket.onmessage, null);
  } finally { f.client.stop(); }
});
test('semantic transport requests provider turn detection and does not locally commit on loud audio', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture({ semantic: true, requireSemantic: true });
  const pending = f.client.start(); await Promise.resolve(); f.emit({ type: 'ready', turnDetection: 'semantic' }); await pending;
  const voiced = new Int16Array(2400).fill(1000).buffer;
  try {
    for (let i = 0; i < 100; i++) { now += 100; f.client.append(voiced, 24_000, 1); }
    assert.equal(f.sent.map((value) => JSON.parse(value)).some((event) => event.type === 'input_audio_buffer.commit'), false);
    f.emit({ type: 'input_audio_buffer.speech_started' });
    f.emit({ type: 'input_audio_buffer.speech_stopped' });
    assert.equal(f.starts, 1);
    assert.equal(f.stops, 1);
    assert.equal(f.activity, 1);
  } finally { f.client.stop(); }
});
test('required semantic transport fails closed instead of falling back to client timing', async () => {
  const f = fixture({ semantic: true, requireSemantic: true });
  const pending = f.client.start(); await Promise.resolve(); f.emit({ type: 'ready', turnDetection: 'client' });
  await assert.rejects(pending, /Semantic turn detection is unavailable/);
  assert(f.stopped);
});
test('cancelling a pending microphone handshake rejects promptly without late callback errors', async () => {
  const f = fixture();
  const pending = f.client.start(); await Promise.resolve(); f.client.stop();
  await assert.rejects(pending, /cancelled/); assert(f.stopped); assert.deepEqual(f.errors, []);
});
test('an idle capture gap cannot commit the first fragment of the next utterance', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture();
  const pending = f.client.start(); await Promise.resolve(); f.emit({ type: 'ready' }); await pending;
  const voiced = new Int16Array(2400).fill(1000).buffer;
  const commits = () => f.sent.map((value) => JSON.parse(value)).filter((event) => event.type === 'input_audio_buffer.commit').length;
  try {
    now += 20_000;
    f.client.append(voiced, 24_000, 1);
    assert.equal(commits(), 0, 'first 100 ms is not a complete request');
    now += 100;
    f.client.append(voiced, 24_000, 1);
    assert.equal(commits(), 0);
    now += 8000;
    f.client.append(voiced, 24_000, 1);
    assert.equal(commits(), 1, 'an active buffer still has a bounded duration');
    now += 20_000;
    f.client.append(voiced, 24_000, 1);
    assert.equal(commits(), 1, 'a later turn starts its own timing window');
  } finally { f.client.stop(); }
});
