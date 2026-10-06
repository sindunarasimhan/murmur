import assert from 'node:assert/strict';
import test from 'node:test';
import { LennyVoiceController, wakeRequest, type ListeningPorts } from './voice-controller';
import { ForegroundVoice } from './foreground-voice';
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
    audio: { position: () => position, playing: () => playing, pause: () => { playing = false; }, play: () => { playing = true; },
      load: async (_episode, value) => { position = value; }, seek: async (value) => { position = value; return value; }, clear: () => { position = 0; } },
    speech: { say: async (text) => { spoken.push(text); }, stop: async () => {} },
    api: {
      invite: async () => 'Which podcast shall we listen to?',
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
    assert(!s.mic); assert(!s.playing); assert.equal(s.spoken.length, spoken);
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
test('a corrected final wake transcript interrupts playback even when its partial was ignored', async () => {
  const s = setup();
  try {
    await s.controller.activate(); await s.controller.submit('play Lenny'); s.seek(123.375);
    s.controller.partial('Hey', 'corrected-wake');
    assert(s.playing);
    s.controller.final('Hey Murmur, explain that', 'corrected-wake');
    assert(!s.playing);
    await delay();
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
    assert(s.playing); assert.equal(s.position, 123.375); assert(s.spoken.includes('Back to Lenny.'));
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
    assert.equal(s.controller.state.phase, 'paused'); assert.match(s.controller.state.error!, /Could not seek/);
    assert.equal(s.position, 25); assert.equal(s.controller.state.episode?.id, episode.id);
    assert(!s.spoken.includes('Ad skipped. Back to Lenny.'));
  } finally { await s.controller.dispose(); }
});
