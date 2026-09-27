import assert from 'node:assert/strict';
import test from 'node:test';
import { AbortController as NativeController, AbortSignal as NativeSignal } from 'abort-controller';
import { listeningApi } from './listening-client';

test('identity, catalog, intent and speech requests tolerate React Native cancellation globals', async (t) => {
  const original = { controller: globalThis.AbortController, signal: globalThis.AbortSignal, fetch: globalThis.fetch, platform: process.env.EXPO_OS };
  globalThis.AbortController = NativeController as unknown as typeof AbortController;
  globalThis.AbortSignal = NativeSignal as unknown as typeof AbortSignal;
  process.env.EXPO_OS = 'web';
  t.after(() => {
    globalThis.AbortController = original.controller;
    globalThis.AbortSignal = original.signal;
    globalThis.fetch = original.fetch;
    if (original.platform === undefined) delete process.env.EXPO_OS;
    else process.env.EXPO_OS = original.platform;
  });
  const paths: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert(init?.signal instanceof NativeSignal);
    const path = String(input);
    paths.push(path);
    return {
      ok: true,
      headers: { get: () => 'ai-generated' },
      arrayBuffer: async () => new ArrayBuffer(16),
      json: async () => path.endsWith('/identity') ? { id: '123e4567-e89b-42d3-a456-426614174000' }
        : path.endsWith('/resolve') ? { kind: 'clarify', message: 'Which episode?' } : [],
    } as unknown as Response;
  };
  assert.deepEqual(await listeningApi.catalog(), []);
  assert.equal((await listeningApi.resolve('Let’s hear that', undefined, [])).kind, 'clarify');
  assert.equal((await listeningApi.speech('session', 'turn')).audio.byteLength, 16);
  assert.equal(paths.length, 4);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(listeningApi.resolve('Play that', undefined, [], cancelled.signal), { name: 'AbortError' });
  assert.equal(paths.length, 4);
});
