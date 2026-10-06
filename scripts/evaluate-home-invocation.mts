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
const ffmpeg = process.env.FFMPEG_PATH;
assert(!audioInput || ffmpeg, 'Set FFMPEG_PATH to ffmpeg for --audio generated-speech fixtures.');
const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const fixtures = new Map<string, Buffer>();
async function spokenBytes(text: string, signal: AbortSignal) {
  const response = await fetch(`${expo}/api/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Murmur-Client': 'expo' }, body: JSON.stringify({ text }), signal });
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-murmur-voice-disclosure'), 'ai-generated');
  return Buffer.from(await response.arrayBuffer());
}
async function pcm(text: string) {
  const cached = fixtures.get(text);
  if (cached) return cached;
  const encoded = await spokenBytes(text, AbortSignal.timeout(30_000));
  const decoded = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(ffmpeg!, ['-v', 'error', '-i', 'pipe:0', '-f', 's16le', '-ar', '24000', '-ac', '1', 'pipe:1']);
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.stdin.on('error', reject);
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`Speech fixture decoding failed: ${Buffer.concat(errors).toString()}`)));
    child.stdin.end(encoded);
  });
  assert(decoded.length >= 4800, 'Speech fixture contains enough PCM to transcribe');
  fixtures.set(text, decoded);
  return decoded;
}
let token = '';
async function request(path: string, body?: unknown, method = 'POST') {
  const response = await fetch(`${origin}/v2${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Murmur-Client': 'v2', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}), signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `${path}: ${response.status}`);
  return response.json();
}
const invitations: string[] = [];
const api: ListeningPorts['api'] = {
  invite: async (history) => { const { message } = await request('/catalog/invite', { history }); invitations.push(message); return message; },
  resolve: async (utterance, currentEpisodeId, history) => {
    const resolution = await request('/catalog/resolve', { utterance, currentEpisodeId, history });
    console.log(JSON.stringify({ request: utterance, resolution: resolution.kind, episode: resolution.episode?.id, message: resolution.message }));
    return resolution;
  },
  open: (episodeId) => request('/sessions', { episodeId }),
  session: (id) => request(`/sessions/${id}`, undefined, 'GET'),
  observe: (session, reason, positionSeconds) => request(`/sessions/${session.id}/observations`, { revision: session.revision, audioVersion: session.audioVersion, reason, positionSeconds }),
  turn: async () => { throw new Error('Unexpected episode turn during home invocation'); },
  acknowledge: async () => { throw new Error('Unexpected action acknowledgement'); },
};
const choices = [
  ['Play the Lenny Brian Halligan episode', 'lenny-brian-halligan'],
  ['I want to listen to Benedict Evans', 'lenny-benedict-evans'],
  ['Put on Lenny with Andrew Ambrosino', 'lenny-andrew-ambrosino'],
] as const;
try {
  token = (await request('/identity')).token;
  const catalog = await request('/catalog', undefined, 'GET');
  assert.equal(catalog.length, 50);
  for (let round = 0; round < 2; round++) for (const [utterance, expected] of choices) {
    let position = 0; let playing = false; let bytes = 0;
    const transcripts: string[] = [];
    const controller = new LennyVoiceController({
      api, uuid: randomUUID, changed: () => {}, followupMs: 20,
      microphone: { start: async () => { if (audioInput) await transport.start(); }, stop: async () => transport.stop() },
      audio: { position: () => position, playing: () => playing, pause: () => { playing = false; }, play: () => { playing = true; }, clear: () => {},
        seek: async (value) => position = value,
        load: async (episode, value, signal) => {
          assert.equal(episode.id, expected); position = value;
          const url = episode.audioPath!.startsWith('https:') ? episode.audioPath! : `${origin}/v2${episode.audioPath}`;
          const response = await fetch(url, { headers: { Range: 'bytes=0-1023' }, signal });
          assert.equal(response.status, 206, `Audio bytes for ${expected}`);
          assert((await response.arrayBuffer()).byteLength > 0);
        } },
      speech: { stop: async () => {}, say: async (text, signal) => {
        bytes += (await spokenBytes(text, signal)).byteLength;
      } },
    });
    const transport = new ContinuousTranscription({
      url: () => `${origin.replace(/^http/, 'ws')}/v2/live-voice`, ticket: () => request('/live-voice-ticket'),
      socket: (url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike,
      callbacks: {
        partial: (text, id) => controller.partial(text, id),
        final: (text, id) => {
          transcripts.push(text);
          console.log(JSON.stringify({ round: round + 1, expectedEpisode: expected, transcription: text, phaseAtArrival: controller.state.phase }));
          controller.final(text, id);
        },
        activity: () => controller.activity(), error: (error) => { void controller.fail(error); },
      },
    });
    async function sendPcm(buffer: Buffer) {
      for (let offset = 0; offset < buffer.length; offset += 4800) {
        transport.append(Uint8Array.from(buffer.subarray(offset, offset + 4800)).buffer, 24_000, 1);
        await pause(100);
      }
      transport.commit();
    }
    async function input(text: string) {
      if (audioInput) await sendPcm(await pcm(text));
      else {
        const id = randomUUID(); controller.partial(text, id); controller.final(text, id);
      }
    }
    async function until(phase: string) {
      const deadline = Date.now() + 45_000;
      while (controller.state.phase !== phase) {
        assert(!controller.state.error, controller.state.error);
        assert(Date.now() < deadline, `Timed out in ${controller.state.phase}, expecting ${phase}`);
        await pause(50);
      }
    }
    try {
      await controller.activate();
      const invitationCount = invitations.length;
      await input('Hey Murmur'); await until('followup');
      const heard = controller.state.heard;
      assert.match(heard, /hey[\s,.!?]+mur/i, 'Wake transcript remains visible after the invitation');
      assert.equal(invitations.length, invitationCount + 1);
      const wakeTranscripts = transcripts.slice();
      if (audioInput) {
        const before = transcripts.length;
        await sendPcm(Buffer.alloc(48_000));
        const deadline = Date.now() + 30_000;
        while (transcripts.length === before) {
          assert(!controller.state.error, controller.state.error);
          assert(Date.now() < deadline, 'Silence fixture did not produce a completed transcription');
          await pause(50);
        }
      } else {
        controller.partial('', 'silence'); controller.final('', 'silence');
      }
      await pause(100);
      assert.equal(invitations.length, invitationCount + 1, 'Silence must not generate a second invitation');
      assert.equal(controller.state.heard, heard, 'Silence must not erase recognized words');
      assert.equal(controller.state.phase, 'followup', 'Silence must not dispatch a new request');
      const selectionStart = transcripts.length;
      await input(utterance); await until('playing');
      assert(playing); assert(bytes > 2000); assert.equal(controller.state.episode?.id, expected);
      console.log(JSON.stringify({ round: round + 1, mode: audioInput ? 'generated-PCM-through-live-transcription' : 'injected-text', requested: utterance, wakeTranscripts, silenceTranscripts: transcripts.slice(wakeTranscripts.length, selectionStart), selectionTranscripts: transcripts.slice(selectionStart), expectedEpisode: expected, actualEpisode: controller.state.episode?.id, result: 'PASS' }));
    } finally { await controller.dispose(); }
  }
  console.log(`Generated ${new Set(invitations).size} distinct invitations in ${invitations.length} runs.`);
  console.log('Physical microphone, audible phone playback, and visual transition are NOT verified by this test.');
  if (audioInput) console.log('Generated voice fixtures are reused across rounds; speaker echo, overlapping speech, and the listener’s accent are NOT covered.');
} finally { if (token) await request('/identity', {}, 'DELETE'); }
