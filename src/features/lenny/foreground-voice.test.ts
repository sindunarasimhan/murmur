import assert from 'node:assert/strict';
import test from 'node:test';
import { ForegroundVoice } from './foreground-voice';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function setup() {
  const calls: string[] = [];
  const ports = {
    activate: async () => { calls.push('activate'); },
    suspendVoice: async () => { calls.push('suspendVoice'); },
    dispose: async () => { calls.push('dispose'); },
    fail: async () => { calls.push('fail'); },
  };
  return { calls, ports, lifecycle: new ForegroundVoice(ports) };
}

test('opening starts voice once; permission-dialog transitions do not duplicate capture', async () => {
  const { calls, lifecycle } = setup();
  lifecycle.changed('active');
  lifecycle.changed('inactive');
  lifecycle.changed('active');
  await flush();
  assert.deepEqual(calls, ['activate']);
  await lifecycle.dispose();
});

test('foreground return waits for capture cleanup, even during a pending permission request', async () => {
  const { calls, ports, lifecycle } = setup();
  let releaseStart!: () => void;
  let releaseStop!: () => void;
  ports.activate = () => { calls.push('activate'); return new Promise<void>((resolve) => { releaseStart = resolve; }); };
  ports.suspendVoice = () => { calls.push('suspendVoice'); return new Promise<void>((resolve) => { releaseStop = resolve; }); };
  lifecycle.changed('active'); await flush();
  lifecycle.changed('background');
  lifecycle.changed('active'); await flush();
  assert.deepEqual(calls, ['activate', 'suspendVoice']);
  releaseStart(); releaseStop(); await flush();
  assert.deepEqual(calls, ['activate', 'suspendVoice', 'activate']);
  releaseStart(); await lifecycle.dispose();
});

test('background and disposal invalidate scheduled activation', async () => {
  const { calls, lifecycle } = setup();
  lifecycle.changed('active');
  lifecycle.changed('background');
  await flush();
  assert.deepEqual(calls, ['suspendVoice']);
  lifecycle.changed('active');
  await lifecycle.dispose(); await flush();
  assert.deepEqual(calls, ['suspendVoice', 'dispose']);
});

test('rapid app switching waits for every pending capture cleanup', async () => {
  const { calls, ports, lifecycle } = setup();
  const releases: (() => void)[] = [];
  ports.suspendVoice = () => { calls.push('suspendVoice'); return new Promise<void>((resolve) => { releases.push(resolve); }); };
  lifecycle.changed('active'); await flush();
  lifecycle.changed('background'); lifecycle.changed('active');
  lifecycle.changed('background'); lifecycle.changed('active');
  releases[1]!(); await flush();
  assert.deepEqual(calls, ['activate', 'suspendVoice', 'suspendVoice']);
  releases[0]!(); await flush();
  assert.deepEqual(calls, ['activate', 'suspendVoice', 'suspendVoice', 'activate']);
  await lifecycle.dispose();
});

test('errors and explicit microphone stops do not retry until a real reopen', async () => {
  const { calls, ports, lifecycle } = setup();
  ports.activate = async () => { calls.push('activate'); throw new Error('Voice unavailable'); };
  lifecycle.changed('active'); await flush();
  lifecycle.changed('active'); lifecycle.changed('inactive'); lifecycle.changed('active');
  await flush();
  assert.deepEqual(calls, ['activate', 'fail']);
  ports.activate = async () => { calls.push('activate'); };
  lifecycle.changed('background'); lifecycle.changed('active'); await flush();
  assert.deepEqual(calls, ['activate', 'fail', 'suspendVoice', 'activate']);
  await ports.suspendVoice();
  lifecycle.changed('active'); await flush();
  assert.equal(calls.filter((call) => call === 'activate').length, 2);
  await lifecycle.dispose();
});

test('a rejected suspendVoice is reported but does not poison later foreground recovery', async () => {
  const { calls, ports, lifecycle } = setup();
  ports.suspendVoice = async () => { calls.push('suspendVoice'); throw new Error('Cleanup failed'); };
  lifecycle.changed('active'); await flush();
  lifecycle.changed('background'); await flush();
  lifecycle.changed('active'); await flush();
  assert.deepEqual(calls, ['activate', 'suspendVoice', 'fail', 'activate']);
  await lifecycle.dispose();
});
