import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { LennyVoiceController, type ListeningPorts, type VoicePhase } from '../src/features/lenny/voice-controller';
import { ContinuousTranscription } from '../src/services/voice/continuous-transcription';
import type { WebSocketLike } from '../src/services/voice/realtime-transcription';
import { FOCUS_AUDIO_SHA, FOCUS_EPISODE_ID } from '../backend/focus-episode';

const origin = process.env.MURMUR_BACKEND_URL ?? 'http://127.0.0.1:4545';
const expo = process.env.MURMUR_EXPO_URL ?? 'http://127.0.0.1:8081';
const audioInput = process.argv.includes('--audio');
const overlap = process.argv.includes('--overlap');
const backgroundGain = Number(process.env.MURMUR_TEST_BACKGROUND_GAIN ?? 0.3);
const ffmpeg = process.env.FFMPEG_PATH;
assert(!overlap || audioInput, '--overlap requires --audio');
assert(!audioInput || ffmpeg, 'Set FFMPEG_PATH for generated-speech input.');
assert(Number.isFinite(backgroundGain) && backgroundGain >= 0 && backgroundGain <= 2);
const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let token = '';
let sessionId = '';
let position = 0;
let playing = false;
let ducked = false;
let loads = 0;
let responses = 0;
let requests = 0;
let speechBytes = 0;
let stage = 'initialization';
const transcripts: string[] = [];
const answers: { answer: string; evidence: unknown[] }[] = [];
const fixtures = new Map<string, Buffer>();
const states: { phase: VoicePhase; heard: string; microphone: boolean }[] = [];
let background: Buffer | undefined;

async function request(path: string, body?: unknown, method = 'POST') {
  const response = await fetch(`${origin}/v2${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Murmur-Client': 'v2', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}), signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${(await response.text()).slice(0, 1200)}`);
  return response.json();
}
async function spokenBytes(text: string, signal = AbortSignal.timeout(30_000)) {
  const response = await fetch(`${expo}/api/speech`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Murmur-Client': 'expo' }, body: JSON.stringify({ text }), signal });
  assert.equal(response.status, 200, `Generated speech endpoint${response.ok ? '' : `: ${(await response.text()).slice(0, 500)}`}`);
  assert.equal(response.headers.get('x-murmur-voice-disclosure'), 'ai-generated');
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length > 1000, 'Generated reply contains audio bytes');
  return bytes;
}
async function decode(args: string[], bytes?: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(ffmpeg!, ['-v', 'error', ...args, '-f', 's16le', '-ar', '24000', '-ac', '1', 'pipe:1']);
    const chunks: Buffer[] = []; const errors: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.stdin.on('error', reject); child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(Buffer.concat(errors).toString())));
    child.stdin.end(bytes);
  });
}
async function pcm(text: string) {
  if (!fixtures.has(text)) fixtures.set(text, await decode(['-i', 'pipe:0'], await spokenBytes(text)));
  return fixtures.get(text)!;
}
const api: ListeningPorts['api'] = {
  invite: async (history) => { requests++; return (await request('/catalog/invite', { history })).message; },
  resolve: async (utterance, currentEpisodeId, history) => {
    requests++; const resolution = await request('/catalog/resolve', { utterance, currentEpisodeId, history });
    console.log(JSON.stringify({ stage, resolution: resolution.kind, message: resolution.message })); return resolution;
  },
  open: async (episodeId) => { const session = await request('/sessions', { episodeId }); sessionId = session.id; return session; },
  session: (id) => request(`/sessions/${id}`, undefined, 'GET'),
  observe: (session, reason, positionSeconds) => request(`/sessions/${session.id}/observations`, { revision: session.revision, audioVersion: session.audioVersion, reason, positionSeconds }),
  turn: async (session, utterance, positionSeconds, requestId, _signal, resumeAfterAction) => {
    const turn = await request(`/sessions/${session.id}/turns`, { revision: session.revision, audioVersion: session.audioVersion, utterance, positionSeconds, requestId, resumeAfterAction });
    console.log(JSON.stringify({ stage, action: turn.action, answer: turn.answer, decision: turn.decision }));
    if (!turn.action) answers.push({ answer: turn.answer, evidence: turn.evidence });
    return turn;
  },
  acknowledge: (session, actionId, positionSeconds) => request(`/sessions/${session.id}/acknowledgements`, { revision: session.revision, audioVersion: session.audioVersion, actionId, positionSeconds }),
};
const controller = new LennyVoiceController({
  api, uuid: randomUUID, followupMs: 100,
  changed: (state) => states.push({ phase: state.phase, heard: state.heard, microphone: state.microphone }),
  microphone: { start: async () => { if (audioInput) await transport.start(); }, stop: async () => transport.stop() },
  audio: { position: () => position, playing: () => playing, setDucked: (value) => { ducked = value; }, pause: () => { playing = false; }, play: () => { playing = true; },
    clear: () => { playing = false; }, seek: async (seconds) => position = seconds,
    load: async (episode, seconds, signal) => {
      loads++;
      assert.equal(episode.id, FOCUS_EPISODE_ID); assert.equal(episode.audioVersion, FOCUS_AUDIO_SHA); position = seconds;
      const url = episode.audioPath!.startsWith('https:') ? episode.audioPath! : `${origin}/v2${episode.audioPath}`;
      const response = await fetch(url, { headers: { Range: 'bytes=0-1023' }, signal });
      assert.equal(response.status, 206); assert((await response.arrayBuffer()).byteLength > 0);
      if (overlap) background = await decode(['-ss', '270.375', '-i', url, '-t', '15']);
    } },
  speech: { stop: async () => {}, say: async (text, signal) => { speechBytes += (await spokenBytes(text, signal)).byteLength; responses++; } },
});
const transport = new ContinuousTranscription({
  url: () => `${origin.replace(/^http/, 'ws')}/v2/live-voice`, ticket: () => request('/live-voice-ticket'),
  socket: (url, protocols) => new WebSocket(url, protocols) as unknown as WebSocketLike,
  callbacks: {
    partial: (text, id) => controller.partial(text, id),
    final: (text, id) => { transcripts.push(text); console.log(JSON.stringify({ stage, transcription: text, phaseAtArrival: controller.state.phase })); controller.final(text, id); },
    activity: () => controller.activity(), error: (error) => { void controller.fail(error); },
  },
});
async function feed(bytes: Buffer, mix: boolean) {
  for (let offset = 0; offset < bytes.length; offset += 4800) {
    const frame = Buffer.from(bytes.subarray(offset, offset + 4800));
    if (mix && playing && background) for (let index = 0; index + 1 < frame.length; index += 2) {
      const value = frame.readInt16LE(index) + background.readInt16LE((offset + index) % (background.length - background.length % 2)) * backgroundGain * (ducked ? 0.2 : 1);
      frame.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), index);
    }
    transport.append(Uint8Array.from(frame).buffer, 24_000, 1); await pause(100);
  }
}
async function utter(label: string, text: string, expected: VoicePhase) {
  stage = label;
  const initialResponses = responses; const initialRequests = requests;
  const transcriptStart = transcripts.length; const stateStart = states.length;
  if (audioInput) {
    const bytes = await pcm(text);
    if (overlap && playing) await feed(Buffer.alloc(48_000 * 2), true);
    await feed(bytes, overlap); transport.commit();
  } else {
    const id = randomUUID(); controller.partial(text, id); controller.final(text, id);
  }
  const started = Date.now(); const deadline = started + 60_000;
  while (responses === initialResponses || controller.state.phase !== expected) {
    assert(!controller.state.error, `${label}: ${controller.state.error}`);
    if (audioInput && transcripts.length > transcriptStart && requests === initialRequests && Date.now() - started > 4000) {
      assert.fail(`${label}: transcription arrived but was not accepted as a request: ${JSON.stringify(transcripts.slice(transcriptStart))}; phase=${controller.state.phase}`);
    }
    if (responses > initialResponses && ['playing', 'paused', 'followup'].includes(controller.state.phase) && Date.now() - started > 2000) {
      assert.equal(controller.state.phase, expected, `${label}: request completed in the wrong state`);
    }
    assert(Date.now() < deadline, `${label}: expected ${expected}, got ${controller.state.phase}; transcripts=${JSON.stringify(transcripts.slice(transcriptStart))}`);
    await pause(50);
  }
  assert(controller.state.microphone, `${label}: microphone remains active`);
  assert(states.slice(stateStart).some((state) => state.heard.trim()), `${label}: recognized input exposed to UI state`);
  console.log(JSON.stringify({ stage: label, result: 'PASS', phase: controller.state.phase, position, playing, transcripts: transcripts.slice(transcriptStart) }));
  await pause(750);
}
try {
  token = (await request('/identity')).token;
  await controller.activate();
  await utter('home wake', 'Hey Murmur', 'followup');
  await utter('home to detail', 'Play the Lenny Brian Halligan episode', 'playing');
  assert(playing); assert.equal(controller.state.episode?.id, FOCUS_EPISODE_ID);
  position = 270.375;
  await utter('detail pause', 'Hey Murmur, pause the podcast', 'paused');
  assert(!playing); assert.equal(position, 270.375);
  await utter('detail resume', 'Hey Murmur, continue where we left off', 'playing');
  assert(playing); assert.equal(position, 270.375);
  await utter('contextual question', 'Hey Murmur, what does he mean by that?', 'followup');
  assert(!playing); assert.equal((await api.session(sessionId)).bookmarkSeconds, 270.375);
  await utter('unprefixed followup', 'Could you give me a concrete example?', 'followup');
  assert.equal(answers.length, 2); assert(answers.every((answer) => answer.answer.trim() && answer.evidence.length > 0));
  await utter('natural return', 'Take me back to the podcast now', 'playing');
  assert(playing); assert.equal(position, 270.375);
  position = 2240;
  await controller.progress();
  console.log('Fixture positions the simulated player inside the reviewed midroll; this is not a voice-seek test.');
  await utter('skip ad while playing', 'Hey Murmur, skip this ad', 'playing');
  assert(playing); assert.equal(position, 2290);
  await utter('pause after ad', 'Hey Murmur, pause', 'paused');
  position = 2240;
  controller.playbackChanged(false);
  await utter('skip ad while paused', 'Hey Murmur, skip the advertisement', 'paused');
  assert(!playing); assert.equal(position, 2290);
  await utter('resume after paused skip', 'Hey Murmur, resume', 'playing');
  assert(playing); assert.equal(position, 2290);
  const loadsBeforeBackground = loads;
  await controller.suspendVoice();
  assert(!controller.state.microphone); assert(playing); assert(!ducked);
  position = 2310;
  playing = false;
  controller.playbackChanged(false);
  await controller.activate();
  assert.equal(controller.state.phase, 'paused'); assert.equal(position, 2310); assert.equal(loads, loadsBeforeBackground);
  await utter('resume after background controls', 'Hey Murmur, pick up from there', 'playing');
  assert.equal(position, 2310);
  await utter('end episode and return home', 'Hey Murmur, end the stream', 'followup');
  assert(!controller.state.episode); assert(!playing); assert(!ducked); assert(controller.state.microphone);
  console.log(JSON.stringify({ result: 'PASS', input: audioInput ? 'generated PCM through live transcription' : 'injected text', overlap, backgroundGain: overlap ? backgroundGain : undefined, speechBytes, assertions: 'home invitation, selection, detail input visibility, pause, exact resume, grounded question, followup, exact return, reviewed skip, paused skip, background voice off, reopen without reload, end to home' }));
} catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', stage, phase: controller.state.phase, position, playing, transcripts, recentStates: states.slice(-12) }));
  throw error;
} finally {
  await controller.dispose(); if (token) await request('/identity', {}, 'DELETE');
  console.log('SIMULATED PLAYER: no physical microphone, speaker acoustics, audible device playback, or rendered screen transition verified. Overlap is a digital mix of the pinned episode, not a real speaker test.');
}
