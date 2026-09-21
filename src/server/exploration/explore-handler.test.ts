import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleExploreOptions,
  handleExplorePost,
} from './explore-handler';
import { EXPLORE_LIMITS } from './explore-contract';

const body = {
  question: 'What does that mean?',
  intent: 'clarify',
  episode: { title: 'An episode', showTitle: 'A show' },
  playbackPositionSeconds: 61,
  transcriptContext: 'The host is describing an open standard.',
};

function request(value: unknown): Request {
  return new Request('http://localhost/api/explore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Murmur-Client': 'expo' },
    body: JSON.stringify(value),
  });
}

test('answers preflight without authorizing arbitrary browser origins', () => {
  const response = handleExploreOptions();

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.match(
    response.headers.get('access-control-allow-methods') ?? '',
    /POST/,
  );
  assert.match(
    response.headers.get('access-control-allow-headers') ?? '',
    /X-Murmur-Client/,
  );
});

test('rejects requests that do not identify the Murmur client', async () => {
  const response = await handleExplorePost(
    new Request('http://localhost/api/explore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { apiKey: 'test-server-key' },
  );

  assert.equal(response.status, 403);
});

test('returns a typed 503 and does not call OpenAI when the key is missing', async () => {
  let calls = 0;
  const response = await handleExplorePost(request(body), {
    apiKey: ' ',
    fetchImpl: async () => {
      calls += 1;
      return new Response();
    },
  });

  assert.equal(response.status, 503);
  assert.equal(calls, 0);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'provider_not_configured',
      message: 'Murmur answers are not configured on this server.',
      retryable: false,
    },
  });
});

test('calls the Responses API without storage and returns normalized output', async () => {
  let upstreamBody: Record<string, unknown> | undefined;
  let authorization: string | null = null;
  const response = await handleExplorePost(request(body), {
    apiKey: 'test-server-key',
    model: 'test-model',
    fetchImpl: async (_url, init) => {
      authorization = new Headers(init?.headers).get('authorization');
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        model: 'test-model-2026-01-01',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'A grounded answer.' }],
          },
        ],
      });
    },
  });

  assert.equal(response.status, 200);
  assert.equal(authorization, 'Bearer test-server-key');
  assert.equal(upstreamBody?.store, false);
  assert.equal(upstreamBody?.max_output_tokens, 1200);
  assert.deepEqual(upstreamBody?.text, { verbosity: 'low' });
  assert.deepEqual(await response.json(), {
    answer: 'A grounded answer.',
    provider: 'openai',
    model: 'test-model-2026-01-01',
  });
});

test('maps a provider rate limit to a retryable typed error', async () => {
  const response = await handleExplorePost(request(body), {
    apiKey: 'test-server-key',
    fetchImpl: async () => new Response(null, { status: 429 }),
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'provider_unavailable',
      message: 'Murmur is temporarily unavailable. Please try again.',
      retryable: true,
    },
  });
});

test('aborts the provider request when the client request is cancelled', async () => {
  const controller = new AbortController();
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const pending = handleExplorePost(
    new Request('http://localhost/api/explore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Murmur-Client': 'expo' },
      body: JSON.stringify(body),
      signal: controller.signal,
    }),
    {
      apiKey: 'test-server-key',
      fetchImpl: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
          markStarted?.();
        }),
    },
  );

  await started;
  controller.abort();
  const response = await pending;

  assert.equal(response.status, 499);
  assert.equal((await response.json()).error.code, 'request_cancelled');
});

test('rejects malformed requests before contacting the provider', async () => {
  let calls = 0;
  const response = await handleExplorePost(request({ ...body, question: '' }), {
    apiKey: 'test-server-key',
    fetchImpl: async () => {
      calls += 1;
      return new Response();
    },
  });

  assert.equal(response.status, 400);
  assert.equal(calls, 0);
  const responseBody = (await response.json()) as {
    error: { code: string };
  };
  assert.equal(responseBody.error.code, 'invalid_request');
});

test('requires an exact JSON content type', async () => {
  const response = await handleExplorePost(
    new Request('http://localhost/api/explore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/jsonish', 'X-Murmur-Client': 'expo' },
      body: JSON.stringify(body),
    }),
    { apiKey: 'test-server-key' },
  );

  assert.equal(response.status, 400);
  const responseBody = (await response.json()) as {
    error: { code: string };
  };
  assert.equal(responseBody.error.code, 'invalid_request');
});

test('rejects bodies over the byte limit before contacting the provider', async () => {
  let calls = 0;
  const oversizedRequest = new Request('http://localhost/api/explore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Murmur-Client': 'expo' },
    body: 'x'.repeat(EXPLORE_LIMITS.bodyBytes + 1),
  });
  const response = await handleExplorePost(oversizedRequest, {
    apiKey: 'test-server-key',
    fetchImpl: async () => {
      calls += 1;
      return new Response();
    },
  });

  assert.equal(response.status, 413);
  assert.equal(calls, 0);
  const responseBody = (await response.json()) as {
    error: { code: string };
  };
  assert.equal(responseBody.error.code, 'payload_too_large');
});
