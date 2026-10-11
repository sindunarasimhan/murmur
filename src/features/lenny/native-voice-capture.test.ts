import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeVoiceCapture } from './native-voice-capture';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('native startup is not ready until the microphone delivers audio', async () => {
  let release!: () => void;
  let ready = false;
  const capture = new NativeVoiceCapture({
    start: async () => {}, stop: () => {}, recordingMode: async () => {}, playbackMode: async () => {},
    inputReady: () => new Promise<void>((resolve) => { release = resolve; }),
  });
  const pending = capture.start().then(() => { ready = true; });
  await flush();
  assert.equal(ready, false);
  release(); await pending;
  assert.equal(ready, true);
  await capture.stop();
});

test('a microphone that opens without delivering audio fails startup', async () => {
  const capture = new NativeVoiceCapture({
    start: async () => {}, stop: () => {}, recordingMode: async () => {}, playbackMode: async () => {},
    inputReady: async () => { throw new Error('No audio arrived'); },
  });
  await assert.rejects(capture.start(), /No audio arrived/);
  await capture.stop();
});

test('a pending native start finishes cleanup before a newer recording can start', async () => {
  const calls: string[] = [];
  let release!: () => void;
  let starts = 0;
  const capture = new NativeVoiceCapture({
    start: async () => {
      calls.push('start');
      if (++starts === 1) await new Promise<void>((resolve) => { release = resolve; });
    },
    stop: () => { calls.push('stop'); },
    recordingMode: async () => { calls.push('recording'); },
    playbackMode: async () => { calls.push('playback'); },
    inputReady: async () => {},
  });
  const first = capture.start(); await flush();
  const cleanup = capture.stop();
  const second = capture.start(); await flush();
  assert.deepEqual(calls, ['start']);
  release(); await Promise.all([first, cleanup, second]);
  assert.deepEqual(calls, ['start', 'stop', 'playback', 'start', 'recording']);
});

test('native failure does not poison future recording startup or skip restoring playback mode', async () => {
  const calls: string[] = [];
  let broken = true;
  const capture = new NativeVoiceCapture({
    start: async () => { calls.push('start'); },
    stop: () => { calls.push('stop'); if (broken) throw new Error('Native stop failed'); },
    recordingMode: async () => { calls.push('recording'); },
    playbackMode: async () => { calls.push('playback'); },
    inputReady: async () => {},
  });
  await capture.start();
  await assert.rejects(capture.stop(), /Native stop failed/);
  broken = false;
  await capture.stop();
  await capture.start();
  assert.deepEqual(calls, ['start', 'recording', 'stop', 'playback', 'stop', 'playback', 'start', 'recording']);
});
