import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { wakeRequest } from '../src/features/lenny/voice-controller';

// Supply a 24 kHz mono PCM16 WAV saying "Hey Murmur, play Lenny".
const file = process.argv[2];
if (!file) throw new Error('Supply a 24 kHz mono PCM16 WAV path. This test uses live transcription.');
const wav = await readFile(file);
assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
let pcm: Buffer | undefined;
for (let offset = 12; offset + 8 < wav.length;) {
  const kind = wav.toString('ascii', offset, offset + 4); const length = wav.readUInt32LE(offset + 4);
  if (kind === 'fmt ') { assert.equal(wav.readUInt16LE(offset + 8), 1); assert.equal(wav.readUInt16LE(offset + 10), 1); assert.equal(wav.readUInt32LE(offset + 12), 24_000); assert.equal(wav.readUInt16LE(offset + 22), 16); }
  if (kind === 'data') pcm = wav.subarray(offset + 8, offset + 8 + length);
  offset += 8 + length + length % 2;
}
assert(pcm && pcm.length > 4800 && pcm.length < 48_000 * 12);
const base = process.env.MURMUR_BACKEND_URL ?? 'http://127.0.0.1:4545';
let token = '';
async function post(path: string, method = 'POST') {
  const response = await fetch(`${base}/v2${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Murmur-Client': 'v2', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: '{}', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
token = (await post('/identity')).token;
let socket: WebSocket | undefined;
try {
  const ticket = await post('/live-voice-ticket');
  socket = new WebSocket(`${base.replace(/^http/, 'ws')}/v2/live-voice`, [`murmur-ticket.${ticket.token}`]);
  const events: { type: string; transcript?: string; delta?: string; message?: string }[] = [];
  let failure: Error | undefined;
  socket.on('message', (data) => { const event = JSON.parse(data.toString()); events.push(event); if (event.type === 'error') failure = new Error(event.message); });
  socket.on('error', (error) => { failure = error; });
  async function waitFor(predicate: () => boolean) {
    const end = Date.now() + 20_000;
    while (!predicate()) { if (failure) throw failure; if (Date.now() > end) throw new Error('Voice smoke test timed out'); await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  await waitFor(() => events.some((event) => event.type === 'ready'));
  for (let turn = 0; turn < 2; turn++) {
    const prior = events.length;
    for (let offset = 0; offset < pcm.length; offset += 4800) {
      socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.subarray(offset, offset + 4800).toString('base64') }));
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const streamed = events.slice(prior).some((event) => event.type.endsWith('.delta'));
    socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    await waitFor(() => events.filter((event) => event.type.endsWith('.completed')).length === turn + 1);
    const text = events.filter((event) => event.type.endsWith('.completed')).at(-1)!.transcript!;
    assert(wakeRequest(text) !== undefined, `Wake phrase missing from: ${text}`);
    console.log(`Turn ${turn + 1}: ${text}; partial before commit: ${streamed}`);
    assert(streamed, 'Wake detection needs text before the turn is committed');
  }
  console.log('Repeated live transcription on one authenticated connection: passed.');
} finally { socket?.close(); await post('/identity', 'DELETE'); }
