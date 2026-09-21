import assert from 'node:assert/strict';
import test from 'node:test';
import { LennyVoiceController, wakeRequest, type ListeningPorts } from './voice-controller';
import type { ListeningSession, PlaybackAction, PreparedEpisode, TurnResult } from '../../../shared/listening';

const episode: PreparedEpisode = { id: 'lenny-one', title: 'A useful conversation', guest: 'Guest One', showTitle: 'Lenny’s Podcast', description: '', audioVersion: 'a'.repeat(64), durationSeconds: 1000, status: 'ready', audioPath: 'https://example.org/audio.mp3', transcriptReady: true };
const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
function setup(followupMs = 30) {
  let position = 0; let playing = false; let mic = false; let next = 0;
  const spoken: string[] = []; const questions: string[] = [];
  let current: ListeningSession = { id: 'session', episodeId: episode.id, audioVersion: episode.audioVersion, revision: 0, positionSeconds: 0, bookmarkSeconds: null, phase: 'paused', pendingAction: null };
  const ports: ListeningPorts = {
    uuid: () => `request-${++next}`, changed: () => {}, followupMs,
    microphone: { start: async () => { mic = true; }, stop: async () => { mic = false; } },
    audio: { position: () => position, pause: () => { playing = false; }, play: () => { playing = true; },
      load: async (_episode, value) => { position = value; }, seek: async (value) => { position = value; return value; }, clear: () => { position = 0; } },
    speech: { say: async (text) => { spoken.push(text); }, stop: async () => {} },
    api: {
      resolve: async (text) => text === 'play Lenny' ? { kind: 'play', episode, message: 'Lenny with Guest One.' }
        : text === 'stop listening' ? { kind: 'stop', message: 'Microphone off.' } : { kind: 'current', message: '' },
      open: async () => current, session: async () => current,
      observe: async (session, reason, value) => {
        current = { ...session, revision: session.revision + 1, positionSeconds: value,
          bookmarkSeconds: reason === 'interrupt' ? session.bookmarkSeconds ?? value : reason === 'play' ? null : session.bookmarkSeconds,
          phase: reason === 'interrupt' ? 'listening' : reason === 'play' ? 'playing' : reason === 'speech-ended' ? 'exploring' : 'paused' };
        return current;
      },
      turn: async (session, text, value, requestId, _signal, resumeAfterAction) => {
        questions.push(text);
        const inAd = value >= 20 && value < 40;
        const kind = text === 'back to the podcast' ? 'return' : text === 'pause' ? 'pause' : text === 'skip ad' && inAd ? 'skip-ad' : null;
        const action: PlaybackAction | null = kind ? { id: 'action', kind, positionSeconds: kind === 'return' ? session.bookmarkSeconds ?? value : kind === 'skip-ad' ? 40 : value, play: kind === 'skip-ad' ? resumeAfterAction ?? true : kind !== 'pause' } : null;
        current = { ...session, revision: session.revision + 1, phase: 'speaking', pendingAction: action };
        return { session: current, answer: action ? '' : 'A short grounded answer.', action, decision: 'jev', evidence: [], requestId, followUp: text === 'skip ad' ? false : true } satisfies TurnResult;
      },
      acknowledge: async (session, _id, value) => { current = { ...session, positionSeconds: value, revision: session.revision + 1, bookmarkSeconds: null, pendingAction: null }; return current; },
    },
  };
  const controller = new LennyVoiceController(ports);
  return { controller, ports, spoken, questions, seek: (value: number) => { position = value; }, get position() { return position; }, get playing() { return playing; }, get mic() { return mic; } };
}
test('wake phrase requires an explicit Hey Murmur and preserves the following request', () => {
  assert.equal(wakeRequest('People sometimes murmur about pricing.'), undefined);
  assert.equal(wakeRequest('podcast background. Hey, Murmur! What did she mean?'), 'What did she mean?');
  assert.equal(wakeRequest('Hey mur mur, skip this ad'), 'skip this ad');
});
test('tap, spoken episode selection, wake interruption, and silence return preserve the exact bookmark', async () => {
  const s = setup();
  try {
    await s.controller.activate(); assert(s.mic);
    s.controller.partial('Play Lenny', 'choose'); s.controller.final('play Lenny', 'choose'); await delay();
    assert(s.playing); assert.equal(s.controller.state.episode?.id, episode.id);
    s.seek(123.375);
    s.controller.partial('Hey Murmur, explain that', 'ask'); assert(!s.playing);
    s.controller.final('Hey Murmur, explain that', 'ask'); await delay();
    assert.equal(s.controller.state.phase, 'followup');
    await delay(50);
    assert(s.playing); assert.equal(s.position, 123.375); assert(s.spoken.includes('Back to Lenny.'));
  } finally { await s.controller.dispose(); }
});
test('a follow-up needs no new wake phrase and postpones automatic playback', async () => {
  const s = setup();
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(40);
    s.controller.partial('Hey Murmur explain this', 'one'); s.controller.final('Hey Murmur explain this', 'one'); await delay();
    s.controller.activity(); await delay(40); assert(!s.playing);
    s.controller.partial('Give me an example', 'two'); s.controller.final('Give me an example', 'two'); await delay();
    assert(s.questions.includes('Give me an example'));
    await delay(50); assert(s.playing); assert.equal(s.position, 40);
  } finally { await s.controller.dispose(); }
});
test('podcast speech and delayed duplicate transcripts never become commands', async () => {
  const s = setup(200);
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny');
    s.controller.partial('Let us talk about product management', 'background');
    s.controller.partial('Hey Murmur explain that', 'question');
    s.controller.final('Hey Murmur explain that', 'question'); await delay();
    const count = s.questions.length;
    s.controller.final('Let us talk about product management', 'background');
    s.controller.final('Hey Murmur explain that', 'question'); await delay();
    assert.equal(s.questions.length, count);
  } finally { await s.controller.dispose(); }
});
test('explicit pause never resumes after silence and stop listening shuts down capture', async () => {
  const s = setup();
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(50);
    await s.controller.submit('pause'); await delay(50);
    assert(!s.playing); assert(s.mic); assert.equal(s.controller.state.phase, 'paused');
    s.controller.final('Stop listening.', 'stop'); await delay();
    assert(!s.mic); assert(!s.playing); assert.equal(s.controller.state.episode, undefined);
  } finally { await s.controller.dispose(); }
});
test('a late answer cannot restart speech or playback after shutdown', async () => {
  const s = setup();
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny');
    let release!: (value: TurnResult) => void;
    const oldTurn = s.ports.api.turn;
    s.ports.api.turn = (...args) => new Promise((resolve) => { release = (value) => resolve(value); void oldTurn(...args).then((value) => { setTimeout(() => release(value), 35); }); });
    const pending = s.controller.submit('explain'); await delay();
    await s.controller.shutdown(); const spoken = s.spoken.length;
    await pending; assert(!s.mic); assert(!s.playing); assert.equal(s.spoken.length, spoken);
  } finally { await s.controller.dispose(); }
});
test('a question during an explicit pause leaves playback paused after silence', async () => {
  const s = setup();
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny');
    await s.controller.submit('pause');
    s.controller.partial('Hey Murmur explain that', 'paused-question');
    s.controller.final('Hey Murmur explain that', 'paused-question'); await delay(55);
    assert(!s.playing); assert.equal(s.controller.state.phase, 'paused');
  } finally { await s.controller.dispose(); }
});
test('a late cancelled microphone start cannot switch off a newer activation', async () => {
  const s = setup(1000);
  let release!: () => void;
  const start = s.ports.microphone.start;
  s.ports.microphone.start = () => new Promise<void>((resolve) => { release = resolve; });
  try {
    const pending = s.controller.activate(); await delay();
    await s.controller.shutdown();
    s.ports.microphone.start = start;
    await s.controller.activate(); assert(s.mic);
    release(); await pending; assert(s.mic); assert.equal(s.controller.state.phase, 'listening');
  } finally { await s.controller.dispose(); }
});
test('choosing a finished episode again starts it from the beginning', async () => {
  const s = setup(1000);
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny');
    s.seek(episode.durationSeconds); await s.controller.ended();
    await s.controller.submit('play Lenny'); assert(s.playing); assert.equal(s.position, 0);
  } finally { await s.controller.dispose(); }
});
test('an ad skip resumes at its ending and a repeated request leaves the interview untouched', async () => {
  const s = setup(1000);
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(25.375);
    await s.controller.submit('skip ad'); assert.equal(s.position, 40); assert(s.playing);
    assert(s.spoken.includes('Ad skipped. Back to Lenny.'));
    await s.controller.submit('skip ad'); assert.equal(s.position, 40); assert(s.playing);
    assert.equal(s.controller.state.phase, 'playing');
  } finally { await s.controller.dispose(); }
});
test('skipping an ad while paused moves the bookmark and stays paused through silence', async () => {
  const s = setup();
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(25);
    await s.controller.submit('pause'); await s.controller.submit('skip ad'); await delay(45);
    assert.equal(s.position, 40); assert(!s.playing); assert.equal(s.controller.state.phase, 'paused');
    assert(s.spoken.includes('Ad skipped. Still paused.'));
  } finally { await s.controller.dispose(); }
});
test('a wake interruption during a device seek observes its completed destination without restarting playback', async () => {
  const s = setup(1000);
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(25);
    let release!: () => void;
    s.ports.audio.seek = (seconds) => new Promise<number>((resolve) => { release = () => { s.seek(seconds); resolve(seconds); }; });
    const skip = s.controller.submit('skip ad'); await delay();
    s.controller.partial('Hey Murmur, explain that', 'interrupt-seek');
    release(); await skip; await delay();
    assert.equal(s.position, 40); assert(!s.playing);
    const current = await s.ports.api.session('session'); assert.equal(current.bookmarkSeconds, 40);
    assert(!s.spoken.includes('Ad skipped. Back to Lenny.'));
  } finally { await s.controller.dispose(); }
});
test('a failed device seek is never acknowledged as a successful ad skip', async () => {
  const s = setup();
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(25);
    let acknowledgements = 0;
    s.ports.audio.seek = async () => { throw new Error('Could not seek'); };
    s.ports.api.acknowledge = async (session) => { acknowledgements++; return session; };
    await s.controller.submit('skip ad'); assert.equal(acknowledgements, 0); assert(!s.playing); assert(!s.mic);
    assert.equal(s.controller.state.phase, 'error'); assert(!s.spoken.includes('Ad skipped. Back to Lenny.'));
  } finally { await s.controller.dispose(); }
});
