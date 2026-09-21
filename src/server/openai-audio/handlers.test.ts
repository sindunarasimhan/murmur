import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AI_VOICE_DISCLOSURE_HEADER,
  AI_VOICE_DISCLOSURE_VALUE,
  MAX_AUDIO_BYTES,
  MAX_SPEECH_AUDIO_BYTES,
  MAX_SPEECH_BODY_BYTES,
} from '@/server/openai-audio/contracts';
import {
  handleSpeechRequest,
  handleTranscribeRequest,
  handleVoiceCapabilitiesRequest,
} from '@/server/openai-audio/handlers';

function voiceCapabilitiesRequest(includeClientHeader = true): Request {
  return new Request('http://localhost/api/voice-capabilities', {
    method: 'GET',
    headers: includeClientHeader ? { 'X-Murmur-Client': 'expo' } : undefined,
  });
}

function transcriptionRequest(file?: File): Request {
  const form = new FormData();
  if (file) form.set('audio', file);

  return new Request('http://localhost/api/transcribe', {
    method: 'POST',
    headers: { 'X-Murmur-Client': 'expo' },
    body: form,
  });
}

function speechRequest(body: unknown): Request {
  return new Request('http://localhost/api/speech', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Murmur-Client': 'expo',
    },
    body: JSON.stringify(body),
  });
}

test('transcription rejects multiple audio files before contacting OpenAI', async () => {
  const form = new FormData();
  form.append('audio', new File(['one'], 'one.mp3', { type: 'audio/mpeg' }));
  form.append('audio', new File(['two'], 'two.mp3', { type: 'audio/mpeg' }));
  let calls = 0;
  const response = await handleTranscribeRequest(new Request('http://localhost/api/transcribe', {
    method: 'POST', headers: { 'X-Murmur-Client': 'expo' }, body: form,
  }), { environment: { OPENAI_API_KEY: 'key' }, fetch: async () => { calls += 1; return Response.json({}); } });
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
});

test('cancelling speech during download stops the body and preserves cancellation', async () => {
  const controller = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  let cancelled = false;
  const pending = handleSpeechRequest(new Request(speechRequest({ text: 'Hello.' }), { signal: controller.signal }), {
    environment: { OPENAI_API_KEY: 'key' }, fetch: async () => new Response(new ReadableStream({
      pull() { ready(); }, cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'audio/mpeg' } }),
  });
  await started;
  controller.abort();
  const response = await pending;
  assert.equal(response.status, 499);
  assert.equal(cancelled, true);
});

test('voice capabilities report configured transcription without exposing config', async () => {
  const response = handleVoiceCapabilitiesRequest(voiceCapabilitiesRequest(), {
    environment: {
      OPENAI_API_KEY: 'server-secret',
      OPENAI_TRANSCRIBE_MODEL: 'private-model-name',
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.match(response.headers.get('Access-Control-Allow-Methods') ?? '', /\bGET\b/);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { transcription: 'ready' });
  assert.doesNotMatch(body, /server-secret|private-model-name/);
});

test('voice capabilities report unconfigured transcription as a successful state', async () => {
  const response = handleVoiceCapabilitiesRequest(voiceCapabilitiesRequest(), {
    environment: {},
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { transcription: 'unconfigured' });
});

test('voice capabilities reject requests that do not identify the Murmur client', async () => {
  const response = handleVoiceCapabilitiesRequest(voiceCapabilitiesRequest(false), {
    environment: { OPENAI_API_KEY: 'server-secret' },
  });

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'invalid_client');
});

test('transcription rejects missing server config before reading multipart data', async () => {
  const request = new Request('http://localhost/api/transcribe', {
    method: 'POST',
    headers: {
      'Content-Type': 'multipart/form-data; boundary=murmur',
      'Content-Length': String(MAX_AUDIO_BYTES + 256 * 1024),
      'X-Murmur-Client': 'expo',
    },
    body: '--murmur--',
  });
  const response = await handleTranscribeRequest(
    request,
    { environment: {} },
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'openai_not_configured',
      message: 'Voice transcription is temporarily unavailable.',
      retryable: false,
    },
  });
});

test('audio routes reject requests that do not identify the Murmur client', async () => {
  const response = await handleSpeechRequest(
    new Request('http://localhost/api/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Explain that.' }),
    }),
    { environment: { OPENAI_API_KEY: 'server-secret' } },
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'invalid_client');
});

test('transcription requires an audio file', async () => {
  const response = await handleTranscribeRequest(transcriptionRequest(), {
    environment: { OPENAI_API_KEY: 'server-secret' },
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'missing_audio');
});

test('transcription rejects a declared oversized upload before parsing multipart data', async () => {
  const request = new Request('http://localhost/api/transcribe', {
    method: 'POST',
    headers: {
      'Content-Type': 'multipart/form-data; boundary=murmur',
      'Content-Length': String(MAX_AUDIO_BYTES + 256 * 1024),
      'X-Murmur-Client': 'expo',
    },
    body: '--murmur--',
  });

  const response = await handleTranscribeRequest(request, {
    environment: { OPENAI_API_KEY: 'server-secret' },
  });

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'audio_too_large');
});

test('transcription proxies the validated file and returns a stable response', async () => {
  let upstreamUrl = '';
  let upstreamInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    upstreamUrl = String(input);
    upstreamInit = init;
    return Response.json({ text: '  What the speaker meant.  ' });
  };

  const response = await handleTranscribeRequest(
    transcriptionRequest(new File(['recording'], 'question', { type: 'audio/m4a' })),
    {
      environment: {
        OPENAI_API_KEY: 'server-secret',
        OPENAI_TRANSCRIBE_MODEL: 'transcribe-test-model',
      },
      fetch: fetchImpl,
    },
  );

  assert.equal(upstreamUrl, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(new Headers(upstreamInit?.headers).get('Authorization'), 'Bearer server-secret');
  assert.ok(upstreamInit?.body instanceof FormData);
  assert.equal(upstreamInit.body.get('model'), 'transcribe-test-model');
  assert.equal((upstreamInit.body.get('file') as File).name, 'question.m4a');
  assert.deepEqual(await response.json(), {
    transcript: 'What the speaker meant.',
    provider: 'openai',
    model: 'transcribe-test-model',
  });
});

test('speech validates text before contacting OpenAI', async () => {
  let called = false;
  const response = await handleSpeechRequest(speechRequest({ text: '   ' }), {
    environment: { OPENAI_API_KEY: 'server-secret' },
    fetch: async () => {
      called = true;
      return new Response();
    },
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'invalid_text');
  assert.equal(called, false);
});

test('speech rejects an oversized request body before contacting OpenAI', async () => {
  let called = false;
  const request = new Request('http://localhost/api/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Murmur-Client': 'expo' },
    body: 'x'.repeat(MAX_SPEECH_BODY_BYTES + 1),
  });
  const response = await handleSpeechRequest(request, {
    environment: { OPENAI_API_KEY: 'server-secret' },
    fetch: async () => {
      called = true;
      return new Response();
    },
  });

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'payload_too_large');
  assert.equal(called, false);
});

test('speech returns a typed 503 when the server key is absent', async () => {
  const response = await handleSpeechRequest(speechRequest({ text: 'Explain that.' }), {
    environment: {},
  });

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'openai_not_configured');
});

test('speech proxies configured generation and returns disclosed MP3 audio', async () => {
  let upstreamUrl = '';
  let upstreamInit: RequestInit | undefined;
  const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x03]);
  const fetchImpl: typeof fetch = async (input, init) => {
    upstreamUrl = String(input);
    upstreamInit = init;
    return new Response(mp3, { headers: { 'Content-Type': 'audio/mpeg' } });
  };

  const response = await handleSpeechRequest(speechRequest({ text: '  A concise answer.  ' }), {
    environment: {
      OPENAI_API_KEY: 'server-secret',
      OPENAI_SPEECH_MODEL: 'speech-test-model',
      OPENAI_SPEECH_VOICE: 'cedar-test-voice',
    },
    fetch: fetchImpl,
  });

  assert.equal(upstreamUrl, 'https://api.openai.com/v1/audio/speech');
  assert.equal(new Headers(upstreamInit?.headers).get('Authorization'), 'Bearer server-secret');
  assert.deepEqual(JSON.parse(String(upstreamInit?.body)), {
    model: 'speech-test-model',
    voice: 'cedar-test-voice',
    input: 'A concise answer.',
    response_format: 'mp3',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'audio/mpeg');
  assert.equal(
    response.headers.get(AI_VOICE_DISCLOSURE_HEADER),
    AI_VOICE_DISCLOSURE_VALUE,
  );
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), mp3);
});

test('OpenAI rate limits become retryable errors without exposing provider details', async () => {
  const response = await handleSpeechRequest(speechRequest({ text: 'Explain that.' }), {
    environment: { OPENAI_API_KEY: 'server-secret' },
    fetch: async () => Response.json({ error: { message: 'sensitive provider detail' } }, { status: 429 }),
  });

  assert.equal(response.status, 503);
  const body = await response.text();
  assert.match(body, /provider_unavailable/);
  assert.doesNotMatch(body, /sensitive provider detail/);
});

test('speech rejects an unexpected or oversized successful upstream body', async () => {
  const wrongType = await handleSpeechRequest(speechRequest({ text: 'Explain that.' }), {
    environment: { OPENAI_API_KEY: 'server-secret' },
    fetch: async () => Response.json({ audio: 'not really audio' }),
  });
  assert.equal(wrongType.status, 502);

  const oversized = await handleSpeechRequest(speechRequest({ text: 'Explain that.' }), {
    environment: { OPENAI_API_KEY: 'server-secret' },
    fetch: async () =>
      new Response(new Uint8Array([1]), {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(MAX_SPEECH_AUDIO_BYTES + 1),
        },
      }),
  });
  assert.equal(oversized.status, 502);
});
