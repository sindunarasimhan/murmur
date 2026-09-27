import assert from 'node:assert/strict';
import test from 'node:test';
import { AbortController as NativeController } from 'abort-controller';
import { withRequestDeadline } from './request-deadline';

test('requests work with React Native cancellation and no modern AbortSignal helpers', async (t) => {
  const original = globalThis.AbortController;
  globalThis.AbortController = NativeController as unknown as typeof AbortController;
  t.after(() => { globalThis.AbortController = original; });
  const native = new NativeController();
  assert.equal('any' in native.signal.constructor, false);
  assert.equal('timeout' in native.signal.constructor, false);
  assert.equal(await withRequestDeadline(undefined, 100, async (signal) => {
    assert.equal('throwIfAborted' in signal, false);
    assert.equal(signal.aborted, false);
    return 'loaded';
  }), 'loaded');
  await assert.rejects(withRequestDeadline(undefined, 5, (signal) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('timed out')));
  })), /timed out/);
  const external = new AbortController();
  await assert.rejects(withRequestDeadline(external.signal, 100, (signal) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('caller cancelled')));
    external.abort();
  })), /caller cancelled/);
  await assert.rejects(withRequestDeadline(external.signal, 100, async () => assert.fail('Cancelled work must not start')), { name: 'AbortError' });
});
