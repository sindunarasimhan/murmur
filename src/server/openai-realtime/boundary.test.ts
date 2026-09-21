import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRealtimeTokenRequest } from './handler';

function request(body = '{"surface":"discovery"}', contentType = 'application/json', signal?: AbortSignal) {
  return new Request('http://localhost/api/realtime-token', {
    method: 'POST', headers: { 'Content-Type': contentType, 'X-Murmur-Client': 'expo' }, body, signal,
  });
}

test('realtime limits both request bytes and shape before minting credentials', async () => {
  let calls = 0;
  for (const [value, expected] of [
    [request('x'.repeat(2049)), 413], [request('null'), 400],
    [request('{"surface":"discovery","model":"expensive"}'), 400],
    [request('{}', 'application/jsonish'), 415],
  ] as const) {
    const response = await handleRealtimeTokenRequest(value, { apiKey: 'key', fetch: async () => { calls += 1; return Response.json({}); } });
    assert.equal(response.status, expected);
  }
  assert.equal(calls, 0);
});

test('realtime rejects expired, malformed, and oversized credentials without exposing the payload', async () => {
  for (const upstream of [
    Response.json(null), Response.json({ value: 'sk_long_lived', expires_at: 4_000_000_000 }),
    Response.json({ value: 'ek_expired', expires_at: 1 }),
    new Response('secret'.repeat(12000)),
  ]) {
    const response = await handleRealtimeTokenRequest(request(), { apiKey: 'key', fetch: async () => upstream });
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /sk_long_lived|ek_expired|secret/);
  }
});

test('realtime client cancellation propagates to a pending credential response body', async () => {
  const controller = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const pending = handleRealtimeTokenRequest(request(undefined, undefined, controller.signal), {
    apiKey: 'key', fetch: async () => new Response(new ReadableStream({ pull() { ready(); } })),
  });
  await started;
  controller.abort();
  const response = await pending;
  assert.equal(response.status, 499);
});
