import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { LennyVoiceController, type ListeningPorts } from '../src/features/lenny/voice-controller';
import { ContinuousTranscription } from '../src/services/voice/continuous-transcription';
import type { WebSocketLike } from '../src/services/voice/realtime-transcription';

const wavPath = process.argv[2];
assert(wavPath, 'Supply a 24kHz mono PCM16 WAV saying Hey Murmur, play Lenny. Uses live providers.');
const wav = await readFile(wavPath);
let pcm: Buffer | undefined;
for (let offset = 12; offset + 8 < wav.length;) {
  const length = wav.readUInt32LE(offset + 4);
  const kind = wav.toString('ascii', offset, offset + 4);
  if (kind === 'fmt ') {
    assert.equal(wav.readUInt16LE(offset + 8), 1);
    assert.equal(wav.readUInt16LE(offset + 10), 1);
    assert.equal(wav.readUInt32LE(offset + 12), 24000);
    assert.equal(wav.readUInt16LE(offset + 22), 16);
  }
  if (kind === 'data') pcm = wav.subarray(offset + 8, offset + 8 + length);
  offset += 8 + length + length % 2;
}
assert(pcm?.length);
const origin = process.env.MURMUR_BACKEND_URL ?? 'http://127.0.0.1:4545';
let token = '';
async function request(path: string, body?: unknown, method = 'POST') {
  const response = await fetch(`${origin}/v2${path}`, { method,
    headers: { 'Content-Type': 'application/json', 'X-Murmur-Client': 'v2', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}), signal: AbortSignal.timeout(30000) });
  assert(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
token = (await request('/identity')).token;
let plays = 0;
let partials = 0;
const speech: string[] = [];
const states: string[] = [];
const unsupported = async (): Promise<never> => { throw new Error('Outside invocation test scope'); };
const api: ListeningPorts['api'] = {
  invite: async (history) => (await request('/catalog/invite', { history })).message,
  resolve: (utterance, currentEpisodeId, history) => request('/catalog/resolve', { utterance, currentEpisodeId, history }),
  open: (episodeId) => request('/sessions', { episodeId }),
  session: (id) => request(`/sessions/${id}`, undefined, 'GET'),
  observe: (session, reason, positionSeconds) => request(`/sessions/${session.id}/observations`, { revision: session.revision, audioVersion: session.audioVersion, reason, positionSeconds }),
  turn: unsupported, acknowledge: unsupported,
};
const controller = new LennyVoiceController({
  uuid: randomUUID, api, followupMs: 6000,
  changed: (state) => { if (states.at(-1) !== state.phase) states.push(state.phase); },
  audio: {
    position: () => 0, playing: () => false, pause: () => {}, clear: () => {}, seek: async (seconds) => seconds,
    load: async (episode) => {
      assert(episode.audioPath);
      const response = await fetch(episode.audioPath.startsWith('https:') ? episode.audioPath : `${origin}/v2${episode.audioPath}`, { headers: { Range: 'bytes=0-1023' } });
      assert.equal(response.status, 206); assert((await response.arrayBuffer()).byteLength > 0);
    },
    play: () => { plays++; },
  },
  speech: { stop: async () => {}, say: async (text, signal) => {
    const response = await fetch(`${process.env.MURMUR_EXPO_URL ?? 'http://127.0.0.1:8081'}/api/speech`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Murmur-Client': 'expo' },
      body: JSON.stringify({ text }), signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    });
    assert.equal(response.status, 200, 'OpenAI speech endpoint failed');
    assert.equal(response.headers.get('x-murmur-voice-disclosure'), 'ai-generated');
    assert((await response.arrayBuffer()).byteLength > 1000);
    speech.push(text);
  } },
  microphone: { start: () => transport.start(), stop: async () => transport.stop() },
});
const transport = new ContinuousTranscription({
  url: () => `${origin.replace(/^http/, 'ws')}/v2/live-voice`,
  ticket: () => request('/live-voice-ticket'),
  socket: (url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike,
  callbacks: {
    partial: (text, id) => { partials++; controller.partial(text, id); },
    final: (text, id) => controller.final(text, id), activity: () => controller.activity(),
    error: (error) => { void controller.fail(error); },
  },
});
try {
  await controller.activate();
  assert.equal(controller.state.phase, 'listening');
  for (let turn = 1; turn <= 2; turn++) {
    for (let offset = 0; offset < pcm.length; offset += 4800) {
      transport.append(Uint8Array.from(pcm.subarray(offset, offset + 4800)).buffer, 24000, 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    transport.commit();
    const deadline = Date.now() + 30000;
    while (plays < turn) {
      assert.notEqual(controller.state.phase, 'error', controller.state.caption);
      assert(Date.now() < deadline, 'Invocation did not reach playback handoff');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(controller.state.episode?.id, 'lenny-brian-halligan');
    assert(speech.at(-1)?.includes('Halligan'));
    console.log(`Turn ${turn}: live transcript → catalog → session → episode bytes → OpenAI speech bytes → playback handoff PASS`);
  }
  assert(partials > 0);
  console.log(`State transitions: ${states.join(' → ')}`);
  console.log('Native microphone, audible speech, and native playback are NOT exercised by this test.');
} finally {
  await controller.dispose();
  await request('/identity', {}, 'DELETE');
}
