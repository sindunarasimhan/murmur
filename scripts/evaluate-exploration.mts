import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { LennyVoiceController, type ListeningPorts } from '../src/features/lenny/voice-controller';
import { ContinuousTranscription } from '../src/services/voice/continuous-transcription';
import type { WebSocketLike } from '../src/services/voice/realtime-transcription';

const origin = process.env.MURMUR_BACKEND_URL ?? 'http://127.0.0.1:4545';
const expo = process.env.MURMUR_EXPO_URL ?? 'http://127.0.0.1:8081';
const audioInput = process.argv.includes('--audio');
const overlap = process.argv.includes('--overlap');
assert(!overlap || audioInput, '--overlap requires --audio');
const backgroundGain = Number(process.env.MURMUR_TEST_BACKGROUND_GAIN ?? 0.3);
assert(Number.isFinite(backgroundGain) && backgroundGain >= 0 && backgroundGain <= 2);
const ffmpeg = process.env.FFMPEG_PATH;
assert(!audioInput || ffmpeg, 'Set FFMPEG_PATH for generated-speech input.');
let token = '';
async function request(path: string, body?: unknown, method = 'POST') {
  const response = await fetch(`${origin}/v2${path}`, { method,
    headers: { 'Content-Type': 'application/json', 'X-Murmur-Client': 'v2', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}), signal: AbortSignal.timeout(30_000) });
  assert(response.ok, `${path}: HTTP ${response.status}`);
  return response.json();
}
async function spokenBytes(text: string, signal?: AbortSignal) {
  const response = await fetch(`${expo}/api/speech`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Murmur-Client': 'expo' },
    body: JSON.stringify({ text }), signal });
  assert.equal(response.status, 200, 'Speech endpoint');
  assert.equal(response.headers.get('x-murmur-voice-disclosure'), 'ai-generated');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length > 1000);
  return bytes;
}
async function pcm(text: string) {
  const bytes = await spokenBytes(text, AbortSignal.timeout(30_000));
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(ffmpeg!, ['-v', 'error', '-i', 'pipe:0', '-f', 's16le', '-ar', '24000', '-ac', '1', 'pipe:1']);
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('Could not decode speech fixture')));
    child.stdin.end(bytes);
  });
}
token = (await request('/identity')).token;
let position = 0;
let playing = false;
let replies = 0;
const answers: string[] = [];
const evidence: string[][] = [];
const transcripts: string[] = [];
let background: Buffer | undefined;
let sessionId = '';
const api: ListeningPorts['api'] = {
  resolve: (utterance, currentEpisodeId, history) => request('/catalog/resolve', { utterance, currentEpisodeId, history }),
  open: async (episodeId) => { const session = await request('/sessions', { episodeId }); sessionId = session.id; return session; },
  session: (id) => request(`/sessions/${id}`, undefined, 'GET'),
  observe: (session, reason, positionSeconds) => request(`/sessions/${session.id}/observations`, { revision: session.revision, audioVersion: session.audioVersion, reason, positionSeconds }),
  turn: async (session, utterance, positionSeconds, requestId, _signal, resumeAfterAction) => {
    const turn = await request(`/sessions/${session.id}/turns`, { revision: session.revision, audioVersion: session.audioVersion, utterance, positionSeconds, requestId, resumeAfterAction });
    if (!turn.action) { answers.push(turn.answer); evidence.push(turn.evidence.map((item: { id: string }) => item.id)); }
    return turn;
  },
  acknowledge: (session, actionId, positionSeconds) => request(`/sessions/${session.id}/acknowledgements`, { revision: session.revision, audioVersion: session.audioVersion, actionId, positionSeconds }),
};
const controller = new LennyVoiceController({
  uuid: randomUUID, api, changed: () => {}, followupMs: 100,
  audio: { position: () => position, pause: () => { playing = false; }, play: () => { playing = true; },
    clear: () => {}, seek: async (seconds) => { position = seconds; return position; }, load: async (_episode, seconds) => { position = seconds; } },
  speech: { stop: async () => {}, say: async (text, signal) => { await spokenBytes(text, signal); replies++; } },
  microphone: { start: async () => { if (audioInput) await transport.start(); }, stop: async () => transport.stop() },
});
const transport = new ContinuousTranscription({
  url: () => `${origin.replace(/^http/, 'ws')}/v2/live-voice`, ticket: () => request('/live-voice-ticket'),
  socket: (url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike,
  callbacks: { partial: (text, id) => controller.partial(text, id), final: (text, id) => { transcripts.push(text); controller.final(text, id); },
    activity: () => controller.activity(), error: (error) => { void controller.fail(error); } },
});
async function utter(text: string, expected: 'followup' | 'playing') {
  const before = replies;
  const transcriptStart = transcripts.length;
  if (audioInput) {
    const bytes = await pcm(text);
    if (overlap && playing) {
      background ??= await pcm('A growing company needs clear decisions. The team has to learn from its customers, hire carefully, and keep improving how people work together.');
      for (let offset = 0; offset < 48_000 * 3; offset += 4800) {
        const frame = Buffer.alloc(4800);
        for (let i = 0; i < frame.length; i += 2) frame.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(background.readInt16LE((offset + i) % (background.length - background.length % 2)) * backgroundGain))), i);
        transport.append(Uint8Array.from(frame).buffer, 24_000, 1);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    for (let offset = 0; offset < bytes.length; offset += 4800) {
      const frame = Buffer.from(bytes.subarray(offset, offset + 4800));
      if (overlap && playing && background) {
        for (let i = 0; i + 1 < frame.length; i += 2) {
          const mixed = frame.readInt16LE(i) + background.readInt16LE((offset + i) % (background.length - background.length % 2)) * backgroundGain;
          frame.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mixed))), i);
        }
      }
      transport.append(Uint8Array.from(frame).buffer, 24_000, 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    transport.commit();
  } else {
    const id = randomUUID(); controller.partial(text, id); controller.final(text, id);
  }
  const deadline = Date.now() + 45_000;
  while (replies === before || controller.state.phase !== expected) {
    assert.notEqual(controller.state.phase, 'error', controller.state.caption);
    assert(Date.now() < deadline, `Did not reach ${expected}: ${controller.state.phase}, ${controller.state.caption}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  console.log(JSON.stringify({ requested: text, transcripts: transcripts.slice(transcriptStart), phase: controller.state.phase, answer: answers.at(-1), answerCount: answers.length }));
}
try {
  await controller.activate();
  await controller.submit('Play Lenny');
  assert(playing);
  for (const bookmark of [270.375, 2300.625]) {
    position = bookmark;
    const initial = answers.length;
    await utter('Hey Murmur, what does he mean by that?', 'followup');
    assert(!playing);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(controller.state.phase, 'followup', 'Silence must not close the conversation');
    assert(!playing, 'Silence must not restart the episode');
    await utter('Could you give me a concrete example?', 'followup');
    assert(/hypothetical|imagine|suppose/i.test(answers[initial + 1]?.split(/[.!?]/)[0] ?? ''), 'Example must be introduced as hypothetical');
    await utter('What are the downsides of that approach?', 'followup');
    assert.equal(answers.length, initial + 3);
    for (let index = initial; index < initial + 3; index++) {
      assert(evidence[index]!.length > 0, `Answer ${index + 1} must retain episode evidence`);
      assert(!/do not have a matching passage|would you like an explanation/i.test(answers[index]!), `Answer ${index + 1} must be substantive`);
    }
    const saved = await api.session(sessionId);
    assert.equal(saved.bookmarkSeconds, bookmark);
    await utter('Take me back to the podcast now', 'playing');
    assert(playing);
    assert.equal(position, bookmark);
    assert.equal((await api.session(sessionId)).positionSeconds, bookmark);
    console.log(`PASS ${bookmark}: interrupt, three answers, silent pause, natural return to exact bookmark`);
  }
  console.log(JSON.stringify({ input: audioInput ? 'generated speech through live transcription' : 'text', overlap, backgroundGain: overlap ? backgroundGain : undefined, answers, evidence, transcripts }, null, 2));
  console.log('Native microphone, speaker acoustics and audible device playback are not exercised.');
} catch (error) {
  console.log(JSON.stringify({ failedInputTranscripts: transcripts }, null, 2));
  throw error;
} finally { await controller.dispose(); await request('/identity', {}, 'DELETE'); }
