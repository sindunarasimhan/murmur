import assert from 'node:assert/strict';
import test from 'node:test';

import { handleRealtimeTokenRequest } from '@/server/openai-realtime/handler';

function tokenRequest(
  surface: 'discovery' | 'episode' = 'discovery',
  includeClientHeader = true,
): Request {
  return new Request('http://localhost/api/realtime-token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(includeClientHeader ? { 'X-Murmur-Client': 'expo' } : {}),
    },
    body: JSON.stringify({ surface }),
  });
}

test('realtime token route mints a scoped transcription secret', async () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  let upstreamUrl = '';
  let upstreamInit: RequestInit | undefined;
  const response = await handleRealtimeTokenRequest(tokenRequest('episode'), {
    apiKey: 'server-only-key',
    model: 'test-live-transcribe',
    fetch: async (input, init) => {
      upstreamUrl = String(input);
      upstreamInit = init;
      return Response.json({ value: 'ek_test_ephemeral', expires_at: expiresAt });
    },
  });

  assert.equal(upstreamUrl, 'https://api.openai.com/v1/realtime/client_secrets');
  assert.equal(
    new Headers(upstreamInit?.headers).get('Authorization'),
    'Bearer server-only-key',
  );
  const upstreamBody = JSON.parse(String(upstreamInit?.body));
  assert.equal(upstreamBody.session.type, 'transcription');
  assert.equal(upstreamBody.session.audio.input.format.rate, 24_000);
  assert.equal(upstreamBody.session.audio.input.transcription.model, 'test-live-transcribe');
  assert.match(
    upstreamBody.session.audio.input.transcription.prompt,
    /wake phrase Hey Murmur exactly/i,
  );
  assert.equal(upstreamBody.session.audio.input.turn_detection, null);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), {
    clientSecret: 'ek_test_ephemeral',
    expiresAt,
    model: 'test-live-transcribe',
    sampleRate: 24_000,
  });
});

test('realtime token route never exposes the server API key', async () => {
  const response = await handleRealtimeTokenRequest(tokenRequest(), {
    apiKey: 'server-only-key',
    fetch: async () =>
      new Response(JSON.stringify({ error: { message: 'contains upstream details' } }), {
        status: 400,
        headers: { 'x-request-id': 'req_test' },
      }),
  });
  const body = await response.text();

  assert.equal(response.status, 502);
  assert.doesNotMatch(body, /server-only-key|upstream details/);
});

test('realtime token route validates client identity, surface, and configuration', async () => {
  const invalidClient = await handleRealtimeTokenRequest(tokenRequest('discovery', false), {
    apiKey: 'server-key',
  });
  assert.equal(invalidClient.status, 403);

  const invalidSurface = await handleRealtimeTokenRequest(
    new Request('http://localhost/api/realtime-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Murmur-Client': 'expo',
      },
      body: JSON.stringify({ surface: 'studio' }),
    }),
    { apiKey: 'server-key' },
  );
  assert.equal(invalidSurface.status, 400);

  const unconfigured = await handleRealtimeTokenRequest(tokenRequest(), { apiKey: '' });
  assert.equal(unconfigured.status, 503);
  assert.equal((await unconfigured.json()).error.code, 'openai_not_configured');
});
