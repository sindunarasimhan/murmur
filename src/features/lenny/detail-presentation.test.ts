import assert from 'node:assert/strict';
import test from 'node:test';
import { detailPresentation } from './detail-presentation';
import type { VoicePhase, VoiceState } from './voice-controller';

const state: VoiceState = { phase: 'playing', microphone: true, caption: 'Old reply', heard: 'Hey Murmur, pause' };

test('detail retains recognized input through the entire conversation and paused acknowledgement', () => {
  for (const phase of ['listening', 'thinking', 'speaking', 'followup', 'paused', 'playing'] satisfies VoicePhase[]) {
    assert.equal(detailPresentation({ ...state, phase }).heard, state.heard);
  }
});

test('detail separates voice readiness from playback state', () => {
  assert.deepEqual(detailPresentation(state), { voiceStatus: 'Ready', playbackStatus: 'Playing', heard: state.heard, reply: '', error: false });
  assert.equal(detailPresentation({ ...state, phase: 'paused' }).playbackStatus, 'Paused');
  assert.equal(detailPresentation({ ...state, phase: 'thinking' }).playbackStatus, undefined);
});

test('detail prioritizes connection errors and microphone availability over playback', () => {
  for (const phase of ['playing', 'paused', 'listening', 'followup'] satisfies VoicePhase[]) {
    assert.equal(detailPresentation({ ...state, phase, microphone: false }).voiceStatus, 'Mic off');
    const failed = detailPresentation({ ...state, phase, error: 'Voice disconnected', caption: 'Reconnect voice' });
    assert.equal(failed.voiceStatus, 'Connection interrupted');
    assert.equal(failed.reply, 'Voice disconnected');
    assert.equal(failed.error, true);
  }
});

test('detail only displays spoken reply when audio is actually playing', () => {
  assert.equal(detailPresentation({ ...state, phase: 'speaking', speechPlaying: false }).reply, '');
  assert.equal(detailPresentation({ ...state, phase: 'speaking', speechPlaying: false }).voiceStatus, 'Thinking');
  assert.equal(detailPresentation({ ...state, phase: 'speaking', speechPlaying: true }).reply, state.caption);
  assert.equal(detailPresentation({ ...state, phase: 'speaking', speechPlaying: true }).voiceStatus, 'Speaking');
  for (const phase of ['idle', 'connecting', 'listening', 'thinking', 'followup', 'playing', 'paused'] satisfies VoicePhase[]) {
    assert.equal(detailPresentation({ ...state, phase }).reply, '');
  }
});

test('detail status matrix covers connection and active conversation without placeholder prose', () => {
  const statuses: Partial<Record<VoicePhase, string>> = { idle: 'Ready', connecting: 'Connecting', listening: 'Listening', thinking: 'Thinking', followup: 'Listening' };
  for (const [phase, voiceStatus] of Object.entries(statuses)) {
    assert.equal(detailPresentation({ ...state, phase: phase as VoicePhase }).voiceStatus, voiceStatus);
  }
  assert.equal(detailPresentation({ ...state, heard: '' }).heard, '');
});
