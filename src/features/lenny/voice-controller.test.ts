import assert from 'node:assert/strict';
import test from 'node:test';
import { LennyVoiceController, wakeRequest, type ListeningPorts } from './voice-controller';
import { ForegroundVoice } from './foreground-voice';
import type { ListeningSession, PlaybackAction, PreparedEpisode, TurnResult } from '../../../shared/listening';

const episode: PreparedEpisode = { id: 'lenny-one', title: 'A useful conversation', guest: 'Guest One', showTitle: 'Lenny’s Podcast', description: '', audioVersion: 'a'.repeat(64), durationSeconds: 1000, status: 'ready', audioPath: 'https://example.org/audio.mp3', transcriptReady: true };
const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
for (const split of [false, true]) {
  test(`home to detail receives ${split ? 'split' : 'punctuated'} wake, pauses and resumes at the same position`, async () => {
    const s = setup();
    try {
      await s.controller.activate();
      s.controller.final('Hey Murmur', 'home-wake'); await delay();
      s.controller.final('play Lenny', 'home-choice'); await delay();
      assert(s.playing); s.seek(123.375);
      if (split) {
        s.controller.partial('Hey', 'prefix');
        s.controller.final('Hey', 'prefix');
        s.controller.partial('Murmur pause', 'command');
        s.controller.final('Murmur pause', 'command');
      } else {
        s.controller.partial('Hey. Murmur pause', 'command');
        s.controller.final('Hey. Murmur pause', 'command');
      }
      await delay();
      assert.equal(s.questions.at(-1), 'pause');
      assert.equal(s.controller.state.phase, 'paused');
      assert.match(s.controller.state.heard, /Murmur pause/);
      assert.equal(s.position, 123.375); assert(!s.playing);
      s.controller.final('Hey! Murmur, back to the podcast', 'resume'); await delay();
      assert(s.playing); assert.equal(s.position, 123.375);
    } finally { await s.controller.dispose(); }
  });
}
test('detail split wake dispatches once despite late prefix and duplicate finals', async () => {
  const s = setup();
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(91);
    s.controller.partial('Hey', 'prefix');
    s.controller.partial('Murmur', 'command');
    s.controller.final('Hey', 'prefix');
    s.controller.partial('Murmur pause', 'command');
    s.controller.final('Murmur pause', 'command'); await delay();
    s.controller.final('Murmur pause', 'command'); await delay();
    assert.deepEqual(s.questions, ['pause']); assert.equal(s.position, 91); assert(!s.playing);
    assert.equal(s.controller.state.heard, 'Hey Murmur pause');
  } finally { await s.controller.dispose(); }
});
test('detail prefix cannot survive background and foreground voice reconnection', async () => {
  const s = setup();
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny');
    s.controller.partial('Hey', 'old-prefix');
    await s.controller.suspendVoice(); await s.controller.activate();
    s.controller.final('Murmur pause', 'new-command'); await delay();
    assert.deepEqual(s.questions, []); assert(s.playing);
  } finally { await s.controller.dispose(); }
});
test('detail wake native pause callback preserves the pre-interruption ad-skip playback intent', async () => {
  const s = setup();
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(25);
    const pause = s.ports.audio.pause;
    s.ports.audio.pause = () => { pause(); s.controller.playbackChanged(false); };
    s.controller.final('Hey. Murmur skip ad', 'skip'); await delay();
    assert.equal(s.position, 40); assert(s.playing);
  } finally { await s.controller.dispose(); }
});
test('detail punctuation and split assembly do not change home wake recognition', async () => {
  const s = setup();
  let invitations = 0;
  s.ports.api.invite = async () => { invitations++; return 'Which episode?'; };
  try {
    await s.controller.activate();
    s.controller.final('Hey. Murmur', 'punctuated'); await delay();
    s.controller.final('Hey', 'prefix'); s.controller.final('Murmur', 'suffix'); await delay();
    assert.equal(invitations, 0);
    s.controller.final('Hey Murmur', 'normal'); await delay();
    assert.equal(invitations, 1);
  } finally { await s.controller.dispose(); }
});
test('tap pauses immediately, accepts an unprefixed question and resumes after its answer', async () => {
  const s = setup(1000);
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(91);
    await s.controller.talk(); assert(!s.playing); assert.equal(s.controller.state.phase, 'listening');
    s.controller.final('explain that', 'question'); await delay();
    assert.equal(s.questions.at(-1), 'explain that');
    assert(s.playing); assert.equal(s.position, 91);
    s.controller.final('pause', 'podcast-speech'); await delay(); assert(s.playing);
  } finally { await s.controller.dispose(); }
});
for (const initiallyPlaying of [true, false]) {
  test(`tap skip ad confirms before seeking and restores ${initiallyPlaying ? 'playing' : 'paused'}`, async () => {
    const s = setup(1000); const events: string[] = [];
    try {
      await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(25);
      if (!initiallyPlaying) { s.ports.audio.pause(); s.controller.playbackChanged(false); }
      const seek = s.ports.audio.seek;
      s.ports.audio.seek = async (value) => { events.push('seek'); return seek(value); };
      s.ports.speech.say = async (message) => { assert.match(message, /Skipping the ad/); assert(!s.playing); events.push('confirm'); };
      await s.controller.talk(); s.controller.final('skip ad', 'skip'); await delay();
      assert.deepEqual(events, ['confirm', 'seek']); assert.equal(s.position, 40);
      assert.equal(s.playing, initiallyPlaying);
      s.controller.final('pause', 'ambient'); await delay(); assert.equal(s.playing, initiallyPlaying);
    } finally { await s.controller.dispose(); }
  });
}
test('a tap question on an already paused episode does not start playback', async () => {
  const s = setup(1000);
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny');
    await s.controller.talk(); s.controller.final('pause', 'pause'); await delay();
    await s.controller.talk(); s.controller.final('explain that', 'question'); await delay();
    assert(!s.playing); assert.equal(s.controller.state.phase, 'paused');
    await s.controller.talk(); s.controller.final('back to the podcast', 'resume'); await delay();
    assert(s.playing);
  } finally { await s.controller.dispose(); }
});
test('a silent tap times out and restores the exact prior playback position', async () => {
  const s = setup(10);
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(127.5);
    await s.controller.talk(); assert(!s.playing);
    await delay(30); assert(s.playing); assert.equal(s.position, 127.5);
    s.controller.final('pause', 'ambient'); await delay(); assert(s.playing);
  } finally { await s.controller.dispose(); }
});
test('home tap invites an episode choice without changing the selection flow', async () => {
  const s = setup(1000);
  try {
    await s.controller.talk(); assert.equal(s.controller.state.phase, 'followup');
    s.controller.final('play Lenny', 'choice'); await delay();
    assert(s.playing); assert.equal(s.controller.state.episode?.id, episode.id);
  } finally { await s.controller.dispose(); }
});
test('tap explicit pause stays paused and closes the request immediately', async () => {
  const s = setup(10);
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); await s.controller.talk();
    s.controller.final('pause', 'pause'); await delay();
    assert.equal(s.controller.state.phase, 'paused'); assert(!s.playing);
    s.controller.final('back to the podcast', 'late'); await delay(); assert(!s.playing);
  } finally { await s.controller.dispose(); }
});
for (const destination of ['another episode', 'home'] as const) {
  test(`tap permits an unprefixed request for ${destination}`, async () => {
    const s = setup(1000);
    try {
      await s.controller.activate(); await s.controller.submit('play Lenny');
      await s.controller.talk();
      const other = { ...episode, id: 'another-episode', title: 'Another guest' };
      s.ports.api.resolve = async () => destination === 'home'
        ? { kind: 'home', message: '' } : { kind: 'play', episode: other, message: 'Another episode.' };
      s.controller.final(destination, 'followup'); await delay();
      assert.equal(s.controller.state.episode?.id, destination === 'home' ? undefined : other.id);
      assert.equal(s.playing, destination !== 'home'); assert(s.mic);
    } finally { await s.controller.dispose(); }
  });
}
test('background cancels an unfinished tap and restores the prior playback state', async () => {
  const s = setup(1000);
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); await s.controller.talk();
    assert(!s.playing);
    await s.controller.suspendVoice(); assert(s.playing); assert(!s.mic);
    await s.controller.activate(); assert(s.playing);
  } finally { await s.controller.dispose(); }
});
function setup(followupMs = 30) {
  let position = 0; let playing = false; let mic = false; let next = 0;
  const spoken: string[] = []; const questions: string[] = [];
  let current: ListeningSession = { id: 'session', episodeId: episode.id, audioVersion: episode.audioVersion, revision: 0, positionSeconds: 0, bookmarkSeconds: null, phase: 'paused', pendingAction: null };
  const ports: ListeningPorts = {
    uuid: () => `request-${++next}`, changed: () => {}, followupMs,
    microphone: { start: async () => { mic = true; }, stop: async () => { mic = false; } },
    audio: { position: () => position, playing: () => playing, setDucked: () => {}, pause: () => { playing = false; }, play: () => { playing = true; },
      load: async (_episode, value) => { position = value; }, seek: async (value) => { position = value; return value; }, clear: () => { position = 0; } },
    speech: { say: async (text) => { spoken.push(text); }, stop: async () => {} },
    api: {
      invite: async () => 'Which podcast shall we listen to?',
      resolve: async (text) => text === 'play Lenny' ? { kind: 'play', episode, message: 'Lenny with Guest One.' }
        : text === 'stop listening' ? { kind: 'stop', message: 'Microphone off.' } : { kind: 'current', message: '' },
      open: async () => current, session: async () => current,
      observe: async (session, reason, value) => {
        current = { ...session, revision: session.revision + 1, positionSeconds: value,
          pendingAction: null,
          bookmarkSeconds: reason === 'interrupt' ? session.bookmarkSeconds ?? value : ['play', 'pause'].includes(reason) ? null : session.bookmarkSeconds,
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
test('detail wake immediately pauses and confirms in quiet at the saved position', async () => {
  const s = setup(1000); const events: string[] = [];
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(123);
    const pause = s.ports.audio.pause;
    s.ports.audio.pause = () => { events.push('pause'); pause(); };
    Object.assign(s.ports.audio, { setDucked: (value: boolean) => events.push(value ? 'duck' : 'restore') });
    s.ports.speech.say = async () => { events.push('confirm'); assert(!s.playing); };
    s.controller.partial('Hey Murmur', 'detail');
    assert(!s.playing); assert.deepEqual(events, ['pause']);
    s.controller.final('Hey Murmur pause', 'detail'); await delay();
    assert(!s.playing); assert.equal(s.position, 123);
    assert(events.indexOf('pause') < events.indexOf('confirm'));
    assert.equal((await s.ports.api.session('session')).positionSeconds, 123);
    await s.controller.suspendVoice(); assert(!s.playing);
  } finally { await s.controller.dispose(); }
});
for (const wasPlaying of [true, false]) {
  for (const dismissal of ['silence', 'cancel', 'background'] as const) {
    test(`${dismissal} after a detail wake restores original ${wasPlaying ? 'playing' : 'paused'} state`, async () => {
      const s = setup(10);
      try {
        await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(71.25);
        if (!wasPlaying) await s.controller.submit('pause');
        s.controller.final('Hey Murmur', 'wake'); assert(!s.playing);
        if (dismissal === 'silence') await delay(25);
        if (dismissal === 'background') await s.controller.suspendVoice();
        if (dismissal === 'cancel') {
          s.ports.api.resolve = async () => ({ kind: 'cancel', message: '' });
          await s.controller.submit('never mind');
        }
        assert.equal(s.playing, wasPlaying); assert.equal(s.position, 71.25);
      } finally { await s.controller.dispose(); }
    });
  }
}
test('cancel and background after exploration keep the episode paused', async () => {
  const s = setup(10);
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny');
    await s.controller.submit('explain that'); await delay(25); assert(!s.playing);
    s.ports.api.resolve = async () => ({ kind: 'cancel', message: '' });
    await s.controller.submit('never mind'); assert(!s.playing);
    await s.controller.suspendVoice(); assert(!s.playing);
  } finally { await s.controller.dispose(); }
});
test('a resolution error after accepted wake leaves playback paused', async () => {
  const s = setup();
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(91);
    s.ports.api.resolve = async () => { throw new Error('Resolution unavailable'); };
    await s.controller.submit('pause');
    assert(!s.playing); assert.equal(s.position, 91); assert(s.mic);
  } finally { await s.controller.dispose(); }
});
test('a skip interrupting an unfinished pause confirmation preserves original playing intent', async () => {
  const s = setup(1000); let release!: () => void;
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(25);
    s.ports.speech.say = () => new Promise<void>((resolve) => { release = resolve; });
    const pause = s.controller.submit('pause'); await delay(); assert(!s.playing);
    s.ports.speech.say = async () => {};
    s.controller.final('Hey Murmur skip ad', 'replacement'); await delay();
    assert(s.playing); assert.equal(s.position, 40);
    release(); await pause; assert(s.playing);
  } finally { await s.controller.dispose(); }
});
test('background during confirmation cancels the command and restores original playback', async () => {
  const s = setup(1000); let release!: () => void; const duck: boolean[] = [];
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(20);
    Object.assign(s.ports.audio, { setDucked: (value: boolean) => duck.push(value) });
    s.ports.speech.say = () => new Promise<void>((resolve) => { release = resolve; });
    const pending = s.controller.submit('pause'); await delay(); assert(!s.playing);
    await s.controller.suspendVoice(); assert(s.playing); assert.equal(duck.at(-1), false);
    release(); await pending; assert(s.playing);
    await s.controller.activate(); assert(s.playing); assert.equal(s.position, 20);
  } finally { await s.controller.dispose(); }
});
test('bare detail wake settles on silence without changing playback or accepting stale input', async () => {
  const s = setup(10); const duck: boolean[] = [];
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny');
    s.ports.audio.setDucked = (value) => duck.push(value);
    s.controller.final('Hey Murmur', 'wake'); await delay(25);
    assert(s.playing); assert.equal(s.controller.state.phase, 'playing'); assert.equal(duck.at(-1), false);
    s.controller.final('podcast speech', 'ambient'); await delay(); assert.deepEqual(s.questions, []);
  } finally { await s.controller.dispose(); }
});
test('unanswered detail clarification restores playback and wake gating after silence', async () => {
  const s = setup(10); const duck: boolean[] = [];
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny');
    s.ports.audio.setDucked = (value) => duck.push(value);
    s.ports.api.resolve = async () => ({ kind: 'clarify', message: 'Which episode did you mean?', candidates: [] });
    await s.controller.submit('something ambiguous');
    assert(!s.playing); assert(!duck.includes(true));
    await delay(25);
    assert.equal(duck.at(-1), false);
    assert.equal(s.controller.state.phase, 'playing');
    s.controller.final('unrelated podcast speech', 'ambient'); await delay();
    assert.equal(s.controller.state.phase, 'playing');
  } finally { await s.controller.dispose(); }
});
test('question pauses at the wake bookmark before the answer', async () => {
  const s = setup(1000);
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(100);
    s.controller.partial('Hey Murmur', 'question'); assert(!s.playing); assert.equal(s.position, 100);
    s.controller.final('Hey Murmur explain this', 'question'); await delay();
    assert(!s.playing); assert.equal((await s.ports.api.session('session')).bookmarkSeconds, 100);
    await s.controller.submit('back to the podcast'); assert(s.playing); assert.equal(s.position, 100);
  } finally { await s.controller.dispose(); }
});
test('end confirms before clearing and returns to home with microphone available', async () => {
  const s = setup(1000); const events: string[] = [];
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny');
    s.ports.api.resolve = async () => ({ kind: 'home', message: 'What next?' });
    s.ports.speech.say = async () => { assert(s.controller.state.episode); events.push('confirm'); };
    s.ports.audio.clear = () => { events.push('clear'); s.ports.audio.pause(); };
    await s.controller.submit('end stream');
    assert.deepEqual(events, ['confirm', 'clear']); assert(!s.controller.state.episode); assert(s.mic); assert(!s.playing);
    assert.equal(s.controller.state.phase, 'followup');
  } finally { await s.controller.dispose(); }
});
test('background during collection restores playback and rejects the late final', async () => {
  const s = setup(1000); const duck: boolean[] = [];
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny');
    s.ports.audio.setDucked = (value) => duck.push(value);
    s.controller.partial('Hey Murmur', 'wake'); await s.controller.suspendVoice();
    s.controller.final('Hey Murmur pause', 'wake'); await delay();
    assert(s.playing); assert.deepEqual(s.questions, []); assert.equal(duck.at(-1), false);
  } finally { await s.controller.dispose(); }
});
test('background during uncancellable seek records the destination without invoking play', async () => {
  const s = setup(1000); let release!: () => void; let plays = 0;
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(25);
    s.ports.audio.play = () => { plays++; };
    s.ports.audio.seek = (value) => new Promise((resolve) => { release = () => { s.seek(value); resolve(value); }; });
    const pending = s.controller.submit('skip ad'); await delay(); await s.controller.suspendVoice();
    release(); await pending;
    assert.equal(plays, 0); assert.equal((await s.ports.api.session('session')).positionSeconds, 40);
    assert(!s.playing); await s.controller.activate(); assert.equal(s.position, 40);
  } finally { await s.controller.dispose(); }
});
test('semantic cancel restores original playback without seeking', async () => {
  const s = setup(1000); const duck: boolean[] = [];
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(60);
    s.ports.audio.setDucked = (value) => duck.push(value);
    s.ports.api.resolve = async () => ({ kind: 'cancel', message: '' });
    s.ports.audio.seek = async () => { assert.fail('cancel must not seek'); };
    s.controller.final('Hey Murmur never mind', 'cancel'); await delay();
    assert(s.playing); assert.equal(s.position, 60); assert.equal(duck.at(-1), false);
    assert.equal(s.controller.state.phase, 'playing');
  } finally { await s.controller.dispose(); }
});
test('an ad ending during confirmation cannot cause a backward seek or false acknowledgement', async () => {
  const s = setup(1000);
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(39);
    s.ports.speech.say = async () => { s.seek(43); };
    s.ports.audio.seek = async () => { assert.fail('expired skip must not seek'); };
    s.ports.api.acknowledge = async () => { assert.fail('expired skip must not acknowledge'); };
    await s.controller.submit('skip ad');
    assert(s.playing); assert.equal(s.position, 43); assert.equal(s.controller.state.phase, 'playing');
    assert.equal((await s.ports.api.session('session')).pendingAction, null);
  } finally { await s.controller.dispose(); }
});
test('silence followed by a new question captures the new wake position', async () => {
  const s = setup(10);
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(60);
    s.controller.final('Hey Murmur', 'first'); await delay(25); s.seek(80);
    s.controller.final('Hey Murmur explain this', 'second'); await delay();
    assert.equal((await s.ports.api.session('session')).bookmarkSeconds, 80);
  } finally { await s.controller.dispose(); }
});
for (const playing of [true, false]) {
  test(`background keeps the episode ${playing ? 'playing' : 'paused'} and stops only voice`, async () => {
    const s = setup();
    const lifecycle = new ForegroundVoice(s.controller);
    try {
      lifecycle.changed('active'); await delay();
      await s.controller.submit('play Lenny'); s.seek(123.375);
      if (!playing) await s.controller.submit('pause');
      let reloads = 0; s.ports.audio.load = async () => { reloads++; };
      lifecycle.changed('background'); await delay();
      assert.equal(s.mic, false); assert.equal(s.playing, playing);
      assert.equal(s.position, 123.375); assert.equal(s.controller.state.episode?.id, episode.id);
      const requests = s.questions.length;
      s.controller.final('Hey Murmur, explain that', 'background');
      await s.controller.submit('play Lenny');
      assert.equal(s.questions.length, requests); assert.equal(reloads, 0);
      lifecycle.changed('active'); await delay();
      assert(s.mic); assert.equal(s.playing, playing); assert.equal(s.position, 123.375);
      assert.equal(s.controller.state.phase, playing ? 'playing' : 'paused');
      assert.equal(reloads, 0);
    } finally { await lifecycle.dispose(); }
  });
}
test('remote playback and seeking supersede the old conversation bookmark on reopen', async () => {
  const s = setup();
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(100);
    await s.controller.submit('Explain that');
    await s.controller.suspendVoice();
    s.seek(250.75); s.ports.audio.play(); s.controller.playbackChanged(true);
    await s.controller.activate();
    assert(s.playing); assert.equal(s.position, 250.75);
    s.controller.final('Hey Murmur, explain this', 'fresh-wake'); await delay();
    await s.controller.submit('back to the podcast');
    assert.equal(s.position, 250.75); assert(s.playing);
    await s.controller.suspendVoice();
    s.ports.audio.pause(); s.seek(310); s.controller.playbackChanged(false);
    await s.controller.activate();
    assert(!s.playing); assert.equal(s.controller.state.phase, 'paused');
    await s.controller.submit('back to the podcast');
    assert.equal(s.position, 310); assert(s.playing);
  } finally { await s.controller.dispose(); }
});
test('late question results cannot speak or start playback after backgrounding', async () => {
  const s = setup();
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(125);
    const resolve = s.ports.api.resolve;
    let release!: () => void;
    s.ports.api.resolve = async (...args) => { await new Promise<void>((done) => { release = done; }); return resolve(...args); };
    const pending = s.controller.submit('Explain that'); await delay();
    await s.controller.suspendVoice(); const spoken = s.spoken.length;
    release(); await pending;
    assert(!s.mic); assert(s.playing); assert.equal(s.spoken.length, spoken);
    assert.equal(s.position, 125); assert.equal(s.controller.state.episode?.id, episode.id);
  } finally { await s.controller.dispose(); }
});
test('background completion is silent and does not restart when reopened', async () => {
  const s = setup();
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny');
    await s.controller.suspendVoice(); const spoken = s.spoken.length;
    s.seek(1000); s.ports.audio.pause(); await s.controller.ended();
    assert.equal(s.spoken.length, spoken);
    await s.controller.activate();
    assert.equal(s.position, 1000); assert(!s.playing); assert(s.mic);
  } finally { await s.controller.dispose(); }
});
test('voice reconnection failure leaves the background podcast and position intact', async () => {
  const s = setup();
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(155);
    await s.controller.suspendVoice();
    s.ports.microphone.start = async () => { throw new Error('Voice connection unavailable'); };
    await s.controller.activate();
    assert(s.playing); assert.equal(s.position, 155); assert(!s.mic);
    assert.equal(s.controller.state.episode?.id, episode.id);
    assert.match(s.controller.state.error!, /Voice connection unavailable/);
  } finally { await s.controller.dispose(); }
});
test('native pause notifications during a command do not change its resume intent', async () => {
  const s = setup();
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(25);
    const pause = s.ports.audio.pause;
    s.ports.audio.pause = () => { pause(); s.controller.playbackChanged(false); };
    await s.controller.submit('skip ad');
    assert(s.playing); assert.equal(s.position, 40);
  } finally { await s.controller.dispose(); }
});
test('native completion after its paused notification still offers the next episode once', async () => {
  const s = setup();
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny');
    s.seek(1000); s.ports.audio.pause(); s.controller.playbackChanged(false);
    await s.controller.ended(); await s.controller.ended();
    assert.equal(s.spoken.filter((text) => text.includes('end of the episode')).length, 1);
    assert.equal(s.controller.state.phase, 'followup');
  } finally { await s.controller.dispose(); }
});
test('wake phrase requires an explicit Hey Murmur and preserves the following request', () => {
  assert.equal(wakeRequest('People sometimes murmur about pricing.'), undefined);
  assert.equal(wakeRequest('podcast background. Hey, Murmur! What did she mean?'), 'What did she mean?');
  assert.equal(wakeRequest('Hey mur mur, skip this ad'), 'skip this ad');
});
test('bare home wake speaks generated invitation once, then accepts an unprefixed delayed episode choice', async () => {
  const s = setup(10);
  let invitations = 0;
  s.ports.api.invite = async () => { invitations++; return 'What would you enjoy listening to today?'; };
  try {
    await s.controller.activate();
    s.controller.final('Hey Murmur', 'wake'); await delay();
    s.controller.final('Hey Murmur', 'wake'); await delay(25);
    assert.equal(invitations, 1);
    assert.equal(s.spoken.at(-1), 'What would you enjoy listening to today?');
    assert.equal(s.controller.state.phase, 'followup'); assert(!s.playing);
    s.controller.final('play Lenny', 'selection'); await delay();
    assert(s.playing); assert.equal(s.controller.state.episode?.id, episode.id);
  } finally { await s.controller.dispose(); }
});
test('a combined wake and episode request bypasses the invitation', async () => {
  const s = setup();
  s.ports.api.invite = async () => { assert.fail('Do not insert a greeting before a complete request'); };
  try {
    await s.controller.activate();
    s.controller.final('Hey Murmur, play Lenny', 'combined'); await delay();
    assert(s.playing);
  } finally { await s.controller.dispose(); }
});
test('backgrounding cancels a pending invitation without late speech', async () => {
  const s = setup();
  let finish!: (text: string) => void;
  s.ports.api.invite = () => new Promise((resolve) => { finish = resolve; });
  try {
    await s.controller.activate(); s.controller.final('Hey Murmur', 'wake');
    await s.controller.suspendVoice(); finish('What would you like to hear?'); await delay();
    assert.equal(s.spoken.length, 0); assert(!s.mic); assert(!s.playing);
  } finally { await s.controller.dispose(); }
});
test('an episode request spoken while the invitation is generating takes priority', async () => {
  const s = setup();
  let finish!: (text: string) => void;
  s.ports.api.invite = () => new Promise((resolve) => { finish = resolve; });
  try {
    await s.controller.activate(); s.controller.final('Hey Murmur', 'wake');
    s.controller.final('play Lenny', 'selection'); await delay();
    assert(s.playing);
    finish('What would you like to hear?'); await delay();
    assert.equal(s.spoken.length, 1); assert(s.playing);
  } finally { await s.controller.dispose(); }
});
test('wake transcript remains readable through generated invitation and followup', async () => {
  const s = setup();
  try {
    await s.controller.activate();
    s.controller.partial('Hey', 'wake'); assert.equal(s.controller.state.heard, 'Hey');
    s.controller.partial('Hey Murmur', 'wake'); assert.equal(s.controller.state.heard, 'Hey Murmur');
    s.controller.final('Hey Murmur', 'wake'); await delay();
    assert.equal(s.controller.state.heard, 'Hey Murmur');
    assert.equal(s.controller.state.phase, 'followup');
  } finally { await s.controller.dispose(); }
});
test('wake partial keeps listening until the delayed final transcript arrives', async () => {
  const s = setup(10);
  try {
    await s.controller.activate(); await delay(20);
    s.controller.partial('Hey Murmur', 'wake'); await delay(25);
    assert.equal(s.controller.state.phase, 'listening');
    s.controller.final('Hey Murmur,', 'wake'); await delay();
    assert.equal(s.controller.state.phase, 'followup'); assert.equal(s.spoken.length, 1);
    assert.equal(s.controller.state.heard, 'Hey Murmur,');
  } finally { await s.controller.dispose(); }
});
test('empty transcription does not erase text or trigger another invitation', async () => {
  const s = setup(); let invitations = 0;
  s.ports.api.invite = async () => { invitations++; return 'Which podcast would you like?'; };
  try {
    await s.controller.activate();
    s.controller.final('Hey Murmur', 'wake'); await delay();
    const heard = s.controller.state.heard;
    s.controller.partial('', 'silence'); s.controller.final('', 'silence'); await delay();
    assert.equal(invitations, 1); assert.equal(s.controller.state.heard, heard);
  } finally { await s.controller.dispose(); }
});
test('reply beginning during invitation is interpreted when its final arrives after speech ends', async () => {
  const s = setup(); let finish!: () => void;
  const say = s.ports.speech.say;
  s.ports.speech.say = async (...args) => { await say(...args); await new Promise<void>((resolve) => { finish = resolve; }); };
  try {
    await s.controller.activate(); s.controller.final('Hey Murmur', 'wake'); await delay();
    assert.equal(s.controller.state.phase, 'speaking');
    s.controller.partial('play', 'selection');
    finish(); await delay(); s.ports.speech.say = say;
    s.controller.final('play Lenny', 'selection'); await delay();
    assert(s.playing); assert.equal(s.controller.state.episode?.id, episode.id);
  } finally { await s.controller.dispose(); }
});
test('late transcript of the invitation itself is not treated as a listener request', async () => {
  const s = setup();
  let requests = 0; const resolve = s.ports.api.resolve;
  s.ports.api.resolve = async (...args) => { requests++; return resolve(...args); };
  try {
    await s.controller.activate(); s.controller.final('Hey Murmur', 'wake'); await delay();
    s.controller.final('Which podcast shall we listen to?', 'speaker-echo'); await delay();
    assert.equal(requests, 0); assert.equal(s.controller.state.phase, 'followup');
  } finally { await s.controller.dispose(); }
});
for (const finishBeforeSpeech of [true, false]) {
  test(`selection across actual speech callbacks is dispatched once (final before completion: ${finishBeforeSpeech})`, async () => {
    const s = setup(); let finish!: () => void; let requests = 0;
    const say = s.ports.speech.say; const resolve = s.ports.api.resolve;
    s.ports.api.resolve = async (...args) => { requests++; return resolve(...args); };
    s.ports.speech.say = async (...args) => {
      await say(...args); s.controller.speechActivity(true);
      await new Promise<void>((done) => { finish = done; });
      s.controller.speechActivity(false);
    };
    try {
      await s.controller.activate(); s.controller.final('Hey Murmur', 'wake'); await delay();
      assert(s.controller.state.speechPlaying);
      s.controller.partial('play', 'selection'); s.controller.partial('play Lenny', 'selection');
      if (finishBeforeSpeech) s.controller.final('play Lenny', 'selection');
      s.ports.speech.say = say; finish(); await delay();
      if (!finishBeforeSpeech) s.controller.final('play Lenny', 'selection');
      await delay(); s.controller.final('play Lenny', 'selection'); await delay();
      assert(s.playing); assert.equal(requests, 1);
    } finally { await s.controller.dispose(); }
  });
}
test('empty final after activity releases its deadline without closing voice', async (t) => {
  const s = setup();
  try {
    await s.controller.activate(); s.controller.final('Hey Murmur', 'wake'); await delay();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    s.controller.activity(); s.controller.final('', 'silence');
    t.mock.timers.tick(25_000); t.mock.timers.reset(); await delay();
    assert(s.mic); assert.equal(s.controller.state.phase, 'followup'); assert.equal(s.controller.state.error, undefined);
  } finally { t.mock.timers.reset(); await s.controller.dispose(); }
});
test('newer unfinished reply supersedes a queued final during the greeting', async () => {
  const s = setup(); let finish!: () => void; const requests: string[] = [];
  const say = s.ports.speech.say; const resolve = s.ports.api.resolve;
  s.ports.api.resolve = async (...args) => { requests.push(args[0]); return resolve(...args); };
  s.ports.speech.say = () => new Promise<void>((done) => { finish = done; });
  try {
    await s.controller.activate(); s.controller.final('Hey Murmur', 'wake'); await delay();
    s.controller.final('old choice', 'old'); s.controller.partial('play', 'new');
    s.ports.speech.say = say; finish(); await delay();
    assert.deepEqual(requests, []);
    s.controller.final('play Lenny', 'new'); await delay();
    assert.deepEqual(requests, ['play Lenny']); assert(s.playing);
  } finally { await s.controller.dispose(); }
});
test('an older final cannot replace or dispatch newer recognized words', async () => {
  const s = setup(); let requests = 0; const resolve = s.ports.api.resolve;
  s.ports.api.resolve = async (...args) => { requests++; return resolve(...args); };
  try {
    await s.controller.activate();
    s.controller.partial('old choice', 'old'); s.controller.partial('play Lenny', 'new');
    s.controller.final('old choice', 'old'); await delay();
    assert.equal(s.controller.state.heard, 'play Lenny'); assert.equal(requests, 0);
    s.controller.final('play Lenny', 'new'); await delay(); assert(s.playing); assert.equal(requests, 1);
  } finally { await s.controller.dispose(); }
});
test('duplicate wake stays consumed after another item arrives', async () => {
  const s = setup(); let invitations = 0;
  s.ports.api.invite = async () => { invitations++; return 'Which episode would you like?'; };
  try {
    await s.controller.activate(); s.controller.final('Hey Murmur', 'wake'); await delay();
    s.controller.partial('play', 'selection'); s.controller.final('Hey Murmur', 'wake'); await delay();
    assert.equal(invitations, 1); assert.equal(s.controller.state.heard, 'play');
  } finally { await s.controller.dispose(); }
});
test('echo normalization does not become a phrase gate for a real question', async () => {
  const s = setup(); const requests: string[] = [];
  s.ports.api.resolve = async (text) => { requests.push(text); return { kind: 'clarify', message: 'You can choose a guest.' }; };
  try {
    await s.controller.activate(); s.controller.final('Hey Murmur', 'wake'); await delay();
    s.controller.final('WHICH PODCAST SHALL WE LISTEN TO', 'echo'); await delay();
    assert.equal(requests.length, 0);
    s.controller.final('Which podcast has Benedict Evans?', 'question'); await delay();
    assert.deepEqual(requests, ['Which podcast has Benedict Evans?']);
    assert.equal(s.controller.state.heard, 'Which podcast has Benedict Evans?');
  } finally { await s.controller.dispose(); }
});
test('wake plus request stays visible while generated confirmation is speaking', async () => {
  const s = setup(); let finish!: () => void;
  s.ports.speech.say = () => new Promise<void>((resolve) => { finish = resolve; });
  try {
    await s.controller.activate(); s.controller.final('Hey Murmur, play Lenny', 'combined'); await delay();
    assert.equal(s.controller.state.phase, 'speaking'); assert.equal(s.controller.state.heard, 'Hey Murmur, play Lenny');
    finish(); await delay(); assert(s.playing); assert.equal(s.controller.state.heard, '');
  } finally { await s.controller.dispose(); }
});
test('a corrected final wake transcript interrupts playback even when its partial was ignored', async () => {
  const s = setup();
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(123.375);
    s.controller.partial('Hey', 'corrected-wake');
    assert(s.playing);
    s.controller.final('Hey Murmur, explain that', 'corrected-wake');
    assert(!s.playing);
    await delay();
    assert(!s.playing);
    assert.deepEqual(s.questions, ['explain that']);
    s.controller.final('Hey Murmur, explain that', 'corrected-wake');
    await delay();
    assert.deepEqual(s.questions, ['explain that']);
    await s.controller.submit('back to the podcast');
    assert(s.playing); assert.equal(s.position, 123.375);
    s.controller.partial('The next thing', 'podcast');
    s.controller.final('The next thing is to explain that decision', 'podcast');
    await delay();
    assert(s.playing); assert.equal(s.questions.length, 2);
  } finally { await s.controller.dispose(); }
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
      assert.equal(s.spoken.at(-1), resume ? 'Skipping to the conversation.' : 'Skipping the intro and keeping it paused.');
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
    assert.equal(s.controller.state.heard, 'Hey Murmur, play');
    s.controller.final('Hey Murmur, play Lenny', 'wake'); await delay();
    assert(s.playing); assert.equal(s.controller.state.episode?.id, episode.id);
  } finally { await s.controller.dispose(); }
});
test('a detail request failure preserves capture and lets a new wake retry without reloading', async () => {
  const s = setup();
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(83.25);
    const resolve = s.ports.api.resolve;
    s.ports.api.resolve = async () => { throw new Error('Temporary decision failure'); };
    s.controller.final('Hey Murmur pause', 'failed-request'); await delay();
    assert.equal(s.controller.state.error, 'Temporary decision failure');
    assert(s.controller.state.microphone); assert(!s.playing); assert.equal(s.position, 83.25);
    s.ports.api.resolve = resolve;
    s.controller.final('Hey Murmur back to the podcast', 'retry'); await delay();
    assert.equal(s.controller.state.error, undefined); assert(s.playing); assert.equal(s.position, 83.25);
  } finally { await s.controller.dispose(); }
});
test('failed selection speech never starts playback but keeps the microphone available', async () => {
  const s = setup();
  try {
    await s.controller.activate();
    const say = s.ports.speech.say;
    s.ports.speech.say = async () => { throw new Error('Speech unavailable'); };
    await s.controller.submit('play Lenny');
    assert(!s.playing); assert(s.controller.state.microphone);
    assert.equal(s.controller.state.error, 'Speech unavailable');
    s.ports.speech.say = say;
    s.controller.final('Hey Murmur back to the podcast', 'retry'); await delay();
    assert(s.playing); assert.equal(s.controller.state.error, undefined);
  } finally { await s.controller.dispose(); }
});
test('failed home invitation can be retried by voice without reopening', async () => {
  const s = setup();
  try {
    await s.controller.activate();
    const invite = s.ports.api.invite;
    s.ports.api.invite = async () => { throw new Error('Invitation unavailable'); };
    s.controller.final('Hey Murmur', 'failed-invite'); await delay();
    assert(s.controller.state.microphone); assert.equal(s.controller.state.error, 'Invitation unavailable');
    s.ports.api.invite = invite;
    s.controller.final('Hey Murmur', 'retry-invite'); await delay();
    assert.equal(s.controller.state.phase, 'followup'); assert.equal(s.controller.state.error, undefined);
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
test('user speech cuts into an assistant answer and routes the next command before the answer finishes', async () => {
  const s = setup(1000);
  let releaseAnswer!: () => void;
  let speechStops = 0;
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(42);
    s.ports.speech.say = () => new Promise<void>((resolve) => { releaseAnswer = resolve; });
    const answering = s.controller.submit('explain that'); await delay();
    assert.equal(s.controller.state.phase, 'speaking');
    s.ports.speech.stop = async () => { speechStops++; };
    s.controller.partial('pause', 'cut-in'); await delay();
    assert.equal(s.controller.state.phase, 'listening');
    assert.equal(s.controller.state.heard, 'pause');
    assert.equal(s.controller.state.speechPlaying, false);
    assert(speechStops > 0);
    s.ports.speech.say = async () => {};
    s.controller.final('pause', 'cut-in'); await delay();
    assert.equal(s.questions.at(-1), 'pause');
    assert(!s.playing);
    releaseAnswer(); await answering;
    assert(!s.playing);
  } finally { await s.controller.dispose(); }
});
test('wake interruption waits through silence and explicit return preserves the exact bookmark', async () => {
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
    assert(!s.playing); assert.equal(s.controller.state.phase, 'followup');
    s.controller.final('back to the podcast', 'return'); await delay();
    assert(s.playing); assert.equal(s.position, 123.375); assert(s.spoken.includes('Resuming the podcast.'));
  } finally { await s.controller.dispose(); }
});
test('multiple contextual follow-ups need no new wake phrase and never resume automatically', async () => {
  const s = setup();
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(40);
    s.controller.partial('Hey Murmur explain this', 'one'); s.controller.final('Hey Murmur explain this', 'one'); await delay();
    s.controller.activity(); await delay(40); assert(!s.playing);
    s.controller.partial('Give me an example', 'two'); s.controller.final('Give me an example', 'two'); await delay();
    assert(s.questions.includes('Give me an example'));
    await delay(50); assert(!s.playing); assert.equal(s.position, 40);
    const resolve = s.ports.api.resolve;
    s.ports.api.resolve = async (text, id, history, signal) => {
      assert.deepEqual(history.slice(-2), ['Give me an example', 'A short grounded answer.']);
      return resolve(text, id, history, signal);
    };
    s.controller.final('Do not resume yet, explain why', 'three'); await delay();
    assert(s.questions.includes('Do not resume yet, explain why')); assert(!s.playing);
    s.ports.api.resolve = resolve;
    await delay(50);
    s.controller.final('back to the podcast', 'return'); await delay();
    assert(s.playing); assert.equal(s.position, 40);
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
test('starting another episode clears conversation routing context and restores wake gating', async () => {
  const s = setup(10);
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny');
    s.seek(89.125); await s.controller.submit('Explain the idea');
    await delay(80); assert(!s.playing); assert.equal(s.controller.state.phase, 'followup');
    const other = { ...episode, id: 'lenny-two' };
    s.ports.api.resolve = async (text, current, history) => {
      if (text === 'Play a different episode') return { kind: 'play', episode: other, message: 'Starting another episode.' };
      assert.equal(current, other.id); assert.deepEqual(history, []);
      return { kind: 'current', message: '' };
    };
    await s.controller.submit('Play a different episode');
    const count = s.questions.length;
    s.controller.final('Give me an example', 'background-after-switch'); await delay();
    assert.equal(s.questions.length, count); assert(s.playing);
    s.controller.final('Hey Murmur explain this new episode', 'new-question'); await delay();
    assert.equal(s.questions.at(-1), 'explain this new episode'); assert(!s.playing);
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
    assert(!s.playing); assert.equal(s.controller.state.phase, 'followup');
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
    assert(s.spoken.includes('Skipping the ad, then continuing.'));
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
    assert(s.spoken.includes('Skipping the ad and keeping it paused.'));
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
    assert.equal((await s.ports.api.session('session')).positionSeconds, 40);
    s.controller.final('Hey Murmur, explain that', 'interrupt-seek'); await delay();
    assert.equal((await s.ports.api.session('session')).bookmarkSeconds, 40);
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
    await s.controller.submit('skip ad'); assert.equal(acknowledgements, 0); assert(!s.playing); assert(s.mic);
    assert.equal(s.controller.state.phase, 'paused'); assert.match(s.controller.state.error!, /Could not seek/);
    assert.equal(s.position, 25); assert.equal(s.controller.state.episode?.id, episode.id);
    assert(!s.spoken.includes('Ad skipped. Back to Lenny.'));
  } finally { await s.controller.dispose(); }
});
