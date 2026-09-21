import assert from 'node:assert/strict';
import test from 'node:test';
import { apiFailure } from './api';
import { readUpstreamJson, requestUpstream, UpstreamError } from './upstream';

const consume = (response: Response, signal: AbortSignal) => readUpstreamJson(response, 32, signal);
const failure = (kind: UpstreamError['kind']) => (error: unknown) => error instanceof UpstreamError && error.kind === kind;

test('provider deadline covers a response body that stalls after successful headers', async () => {
  let cancelled = false;
  await assert.rejects(requestUpstream('https://provider.example', {}, {
    timeoutMs: 15,
    fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })),
  }, consume), failure('timeout'));
  assert.equal(cancelled, true);
});

test('deadline also bounds a fetch implementation that ignores its abort signal', async () => {
  await assert.rejects(requestUpstream('https://provider.example', {}, {
    timeoutMs: 15, fetch: () => new Promise<Response>(() => {}),
  }, consume), failure('timeout'));
});

test('cancelling after headers stops the body and returns cancellation rather than timeout', async () => {
  const controller = new AbortController();
  let reading!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  let cancelled = false;
  const pending = requestUpstream('https://provider.example', {}, {
    signal: controller.signal, timeoutMs: 1000,
    fetch: async () => new Response(new ReadableStream({ pull() { reading(); }, cancel() { cancelled = true; } })),
  }, consume);
  await started;
  controller.abort();
  await assert.rejects(pending, failure('cancelled'));
  assert.equal(cancelled, true);
});

test('an already cancelled request cannot contact a paid provider', async () => {
  let calls = 0;
  await assert.rejects(requestUpstream('https://provider.example', {}, {
    signal: AbortSignal.abort(), timeoutMs: 1000,
    fetch: async () => { calls += 1; return Response.json({}); },
  }, consume), failure('cancelled'));
  assert.equal(calls, 0);
});

test('invalid and oversized provider JSON is rejected and its stream is closed', async () => {
  for (const response of [new Response('null-not-json'), new Response('x'.repeat(33))]) {
    await assert.rejects(requestUpstream('https://provider.example', {}, {
      timeoutMs: 1000, fetch: async () => response,
    }, consume), failure('invalid'));
  }
});

test('auth, quota, and transient failures have distinct safe responses without paid retries', async () => {
  for (const [status, payload, code, retryable] of [
    [401, { error: { message: 'secret detail' } }, 'provider_authentication', false],
    [403, {}, 'provider_authentication', false],
    [429, { error: { code: 'insufficient_quota', message: 'secret detail' } }, 'provider_quota', false],
    [429, { error: { code: 'rate_limit_exceeded' } }, 'provider_unavailable', true],
    [529, {}, 'provider_unavailable', true],
  ] as const) {
    let calls = 0;
    try {
      await requestUpstream('https://provider.example', {}, {
        timeoutMs: 1000, fetch: async () => { calls += 1; return Response.json(payload, { status }); },
      }, consume);
      assert.fail('Expected provider failure');
    } catch (error) {
      const response = apiFailure(error);
      const body = await response.json();
      assert.equal(body.error.code, code);
      assert.equal(body.error.retryable, retryable);
      assert.doesNotMatch(JSON.stringify(body), /secret detail/);
    }
    assert.equal(calls, 1);
  }
});
