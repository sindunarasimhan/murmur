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
for (const resume of [true, false]) {
  test(`intro skip acknowledges the actual seek and preserves ${resume ? 'playing' : 'paused'} state`, async () => {
    const s = setup();
    try {
      await s.controller.activate();
      await s.controller.submit('play Lenny');
      s.seek(30);
      if (!resume) await s.controller.submit('pause');
      s.ports.api.turn = async (session, _text, _position, requestId, _signal, resumeAfterAction) => {
        assert.equal(resumeAfterAction, resume);
        const action: PlaybackAction = { id: 'intro', kind: 'skip-intro', positionSeconds: 245.3, play: resumeAfterAction ?? true };
        return { session: { ...session, pendingAction: action }, action, requestId, answer: '', decision: 'jev', evidence: [], followUp: false };
      };
      await s.controller.submit('Get to the actual conversation');
      assert.equal(s.position, 245.3);
      assert.equal(s.playing, resume);
      assert.equal(s.controller.state.phase, resume ? 'playing' : 'paused');
      assert.equal(s.spoken.at(-1), resume ? 'Here’s the conversation.' : 'Intro skipped. Still paused.');
    } finally { await s.controller.dispose(); }
  });
}
for (const reply of ['play it', 'Sounds good, let’s hear that', 'Go ahead with the one you mentioned', 'Put that on for me']) {
test(`a delayed contextual reply reaches interpretation without a phrase gate: ${reply}`, async () => {
  const s = setup(15);
  const requests: string[] = [];
  s.ports.api.resolve = async (text, _current, history) => {
    requests.push(text);
    if (text === reply) {
      assert.deepEqual(history, ['What is available?', 'Would you like to play it?']);
      return { kind: 'play', episode, message: 'Starting the episode.' };
    }
    return { kind: 'clarify', message: 'Would you like to play it?' };
  };
  try {
    await s.controller.activate();
    await s.controller.submit('What is available?');
    await delay(25);
    assert.equal(s.controller.state.phase, 'followup');
    assert.equal(requests.length, 1);
    s.controller.partial(reply.slice(0, 4), 'reply');
    s.controller.partial(reply, 'reply');
    s.controller.final(reply, 'reply');
    await delay();
    assert(s.playing);
    assert.equal(s.controller.state.phase, 'playing');
    assert.deepEqual(requests, ['What is available?', reply]);
  } finally { await s.controller.dispose(); }
});
}
test('play it without an outstanding offer still requires a wake phrase when idle', async () => {
  const s = setup(15);
  let requests = 0;
  s.ports.api.resolve = async () => { requests++; return { kind: 'play', episode, message: 'Starting.' }; };
  try {
    await s.controller.activate();
    await delay(25);
    s.controller.final('play it', 'ambient');
    await delay();
    assert.equal(requests, 0);
    assert.equal(s.playing, false);
  } finally { await s.controller.dispose(); }
});
for (const reply of ['Not yet', 'No, I meant a different show', 'Maybe later', 'We are discussing dinner']) {
  test(`a non-accepting delayed reply is interpreted without starting audio: ${reply}`, async () => {
    const s = setup(15);
    const requests: string[] = [];
    s.ports.api.resolve = async (text) => {
      requests.push(text);
      return { kind: 'clarify', message: 'Which episode would you like?' };
    };
    try {
      await s.controller.activate();
      await s.controller.submit('What is available?');
      await delay(25);
      s.controller.final(reply, 'reply');
      await delay();
      assert.deepEqual(requests, ['What is available?', reply]);
      assert.equal(s.playing, false);
      assert.equal(s.controller.state.phase, 'followup');
    } finally { await s.controller.dispose(); }
  });
}
test('idle invocation retains wake monitoring and reactivates without a button', async () => {
  const s = setup(15);
  try {
    await s.controller.activate(); await delay(25);
    assert.equal(s.controller.state.phase, 'idle'); assert(s.mic);
    s.controller.partial('An unrelated background conversation', 'ambient');
    s.controller.final('An unrelated background conversation', 'ambient');
    assert.equal(s.controller.state.phase, 'idle');
    s.controller.partial('Hey Murmur, play', 'wake');
    assert.equal(s.controller.state.phase, 'listening');
    assert.equal(s.controller.state.heard, 'play');
    s.controller.final('Hey Murmur, play Lenny', 'wake'); await delay();
    assert(s.playing); assert.equal(s.controller.state.episode?.id, episode.id);
  } finally { await s.controller.dispose(); }
});
test('voice failure accurately reports microphone off and cannot wake until reopened', async () => {
  const s = setup();
  try {
    await s.controller.activate();
    await s.controller.fail(new Error('Voice is unavailable. Reopen Murmur to try again.'));
    assert.equal(s.controller.state.phase, 'error'); assert(!s.mic);
    s.controller.final('Hey Murmur, play Lenny', 'after-error'); await delay();
    assert(!s.playing); assert.equal(s.controller.state.phase, 'error');
    await s.controller.activate(); assert(s.mic);
  } finally { await s.controller.dispose(); }
});
test('a player cleanup failure cannot hide the original microphone failure', async () => {
  const s = setup();
  s.ports.audio.clear = () => { throw new Error('Native source rejected'); };
  s.ports.microphone.start = async () => { throw new Error('Microphone permission denied'); };
  try {
    await s.controller.activate();
    assert.equal(s.controller.state.phase, 'error');
    assert.match(s.controller.state.caption, /Microphone permission denied/);
    assert.match(s.controller.state.caption, /cleanup also failed/);
    assert.equal(s.spoken.at(-1), s.controller.state.caption);
  } finally { await s.controller.dispose(); }
});
test('disposing after Expo releases the player still stops microphone and speech', async () => {
  const s = setup();
  const stopped: string[] = [];
  s.ports.audio.pause = () => { throw new Error('Native shared object released'); };
  s.ports.microphone.stop = async () => { stopped.push('microphone'); };
  s.ports.speech.stop = async () => { stopped.push('speech'); };
  await s.controller.dispose();
  assert.deepEqual(stopped.sort(), ['microphone', 'speech']);
});
test('speech animation waits for real playback and clears when interrupted', async () => {
  const s = setup();
  let finish!: () => void;
  s.ports.speech.say = () => new Promise<void>((resolve) => { finish = resolve; });
  try {
    await s.controller.activate();
    const pending = s.controller.submit('play Lenny');
    await delay();
    assert.equal(s.controller.state.phase, 'speaking');
    assert.equal(s.controller.state.speechPlaying, false);
    s.controller.speechActivity(true);
    assert.equal(s.controller.state.speechPlaying, true);
    s.controller.partial('Hey Murmur', 'interrupt');
    assert.equal(s.controller.state.speechPlaying, false);
    finish(); await pending;
  } finally { await s.controller.dispose(); }
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
    s.ports.api.resolve = async () => { throw new Error('Network unavailable'); };
    s.controller.final('Stop listening.', 'stop'); await delay();
    assert(!s.mic); assert(!s.playing); assert.equal(s.controller.state.episode, undefined);
    assert.equal(s.controller.state.phase, 'idle');
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
