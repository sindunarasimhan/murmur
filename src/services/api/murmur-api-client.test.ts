import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMurmurApiClient,
  MurmurApiError,
  resolveApiBaseUrl,
  resolveExpoDevelopmentHostUri,
  type ExploreTurnPayload,
} from '@/services/api/murmur-api-client';

const explorePayload: ExploreTurnPayload = {
  question: 'What does open metadata change?',
  intent: 'clarify',
  episode: { title: 'Open audio', showTitle: 'Murmur test' },
  playbackPositionSeconds: 42,
  transcriptContext: 'The feed publishes timed context.',
  history: [],
};

const webRuntime = () => ({ platform: 'web' as const });

test('server cancellation and timeout codes retain their meaning on the client', async () => {
  for (const [code, status, kind, retryable] of [
    ['request_cancelled', 499, 'cancelled', false],
    ['provider_timeout', 504, 'timeout', true],
  ] as const) {
    const client = createMurmurApiClient({ runtime: webRuntime, fetch: async () =>
      Response.json({ error: { code, message: 'Request ended.', retryable } }, { status }),
    });
    await assert.rejects(client.exploreTurn(explorePayload), (error: unknown) =>
      error instanceof MurmurApiError && error.kind === kind && error.retryable === retryable &&
      error.fallbackEligible === retryable);
  }
});

test('quota and revoked-key errors do not invite automatic retries', async () => {
  for (const code of ['provider_quota', 'provider_authentication']) {
    const client = createMurmurApiClient({ runtime: webRuntime, fetch: async () =>
      Response.json({ error: { code, message: 'Account action needed.', retryable: false } }, { status: 503 }),
    });
    await assert.rejects(client.exploreTurn(explorePayload), (error: unknown) =>
      error instanceof MurmurApiError && error.code === code && !error.retryable && error.fallbackEligible);
  }
});

test('keeps web APIs same-origin and resolves Expo development API roots', () => {
  assert.equal(
    resolveApiBaseUrl({
      platform: 'web',
      configuredBaseUrl: 'https://api.example.com/v1/',
    }),
    '/api',
  );
  assert.equal(
    resolveApiBaseUrl({
      platform: 'web',
      configuredBaseUrl: 'http://192.168.1.24:8081/api',
    }),
    '/api',
  );
  assert.equal(resolveApiBaseUrl({ platform: 'web' }), '/api');
  assert.equal(
    resolveApiBaseUrl({
      platform: 'native',
      development: true,
      expoHostUri: '192.168.1.24:8081',
    }),
    'http://192.168.1.24:8081/api',
  );
  assert.equal(
    resolveApiBaseUrl({
      platform: 'native',
      development: true,
      expoHostUri: 'exp://192.168.1.24:8082/--/',
    }),
    'http://192.168.1.24:8082/api',
  );
});

test('uses Expo Go host fallbacks when expoConfig does not expose hostUri', () => {
  assert.equal(
    resolveExpoDevelopmentHostUri({
      debugMode: true,
      expoConfig: null,
      expoGoConfig: { debuggerHost: '192.168.1.24:8082' },
      linkingUri: 'exp://192.168.1.24:8082/--/',
    }),
    '192.168.1.24:8082',
  );
  assert.equal(
    resolveExpoDevelopmentHostUri({
      debugMode: true,
      expoConfig: {},
      expoGoConfig: null,
      linkingUri: 'exp://192.168.1.24:8082/--/',
    }),
    'exp://192.168.1.24:8082/--/',
  );
});

test('a blank optional API URL still uses the Expo Go development host', () => {
  for (const configuredBaseUrl of ['', '   ']) {
    assert.equal(resolveApiBaseUrl({ platform: 'native', development: true,
      configuredBaseUrl, expoHostUri: '192.168.1.24:8081' }), 'http://192.168.1.24:8081/api');
    assert.throws(() => resolveApiBaseUrl({ platform: 'native', development: false, configuredBaseUrl }));
  }
});

test('fails closed when a native API root cannot be resolved safely', () => {
  assert.throws(
    () => resolveApiBaseUrl({ platform: 'native' }),
    (error: unknown) =>
      error instanceof MurmurApiError &&
      error.kind === 'configuration' &&
      error.fallbackEligible,
  );
  assert.throws(
    () =>
      resolveApiBaseUrl({
        platform: 'native',
        configuredBaseUrl: '/api',
      }),
    (error: unknown) => error instanceof MurmurApiError && error.kind === 'configuration',
  );
  assert.throws(
    () =>
      resolveApiBaseUrl({
        platform: 'native',
        configuredBaseUrl: 'http://api.example.com/api',
      }),
    (error: unknown) => error instanceof MurmurApiError && error.kind === 'configuration',
  );
  assert.equal(
    resolveApiBaseUrl({
      platform: 'native',
      development: true,
      configuredBaseUrl: 'http://192.168.1.24:8081/api',
    }),
    'http://192.168.1.24:8081/api',
  );
});

test('checks voice capabilities through the Expo development API root', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const client = createMurmurApiClient({
    runtime: () => ({
      platform: 'native',
      development: true,
      expoHostUri: '192.168.1.218:8082',
    }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return Response.json({ transcription: 'ready' });
    },
  });

  const result = await client.checkVoiceCapabilities();

  assert.deepEqual(result, { transcription: 'ready' });
  assert.equal(requestUrl, 'http://192.168.1.218:8082/api/voice-capabilities');
  assert.equal(requestInit?.method, 'GET');
  const headers = new Headers(requestInit?.headers);
  assert.equal(headers.get('X-Murmur-Client'), 'expo');
  assert.equal(headers.get('Accept'), 'application/json');
  assert.equal(requestInit?.body, undefined);
});

test('requests a short-lived realtime token without exposing server credentials', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const client = createMurmurApiClient({
    runtime: webRuntime,
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return Response.json({
        clientSecret: 'ek_test_client',
        expiresAt: 123456,
        model: 'live-test',
        sampleRate: 24_000,
      });
    },
  });

  const result = await client.createRealtimeSessionToken('episode');

  assert.equal(requestUrl, '/api/realtime-token');
  assert.equal(requestInit?.method, 'POST');
  assert.equal(new Headers(requestInit?.headers).get('X-Murmur-Client'), 'expo');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), { surface: 'episode' });
  assert.deepEqual(result, {
    clientSecret: 'ek_test_client',
    expiresAt: 123456,
    model: 'live-test',
    sampleRate: 24_000,
  });
});

test('searches the production podcast directory through Murmur API routes', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const client = createMurmurApiClient({
    runtime: webRuntime,
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return Response.json({
        provider: 'apple-podcasts-rss',
        query: { directory: 'The Daily', wantsLatest: true },
        podcast: {
          directoryId: '42',
          title: 'The Daily',
          feedUrl: 'https://feeds.example.com/daily',
        },
        episode: {
          id: 'daily-latest',
          guid: 'daily-latest',
          podcastTitle: 'The Daily',
          title: 'Today’s Episode',
          description: 'The latest news.',
          audioAsset: {
            url: 'https://audio.example.com/latest.mp3',
            identityKind: 'feed-locator',
            versionId: 'daily-latest-v1',
          },
          transcriptSources: [],
          adSegments: [],
        },
      });
    },
  });

  const result = await client.searchPodcast('Play the latest episode of The Daily');

  assert.equal(requestUrl, '/api/podcast-search');
  assert.equal(requestInit?.method, 'POST');
  assert.equal(new Headers(requestInit?.headers).get('X-Murmur-Client'), 'expo');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    query: 'Play the latest episode of The Daily',
  });
  assert.equal(result.episode.title, 'Today’s Episode');
});

test('treats unconfigured voice transcription as a valid capability state', async () => {
  const client = createMurmurApiClient({
    runtime: webRuntime,
    fetch: async (input) => {
      assert.equal(String(input), '/api/voice-capabilities');
      return Response.json({ transcription: 'unconfigured' });
    },
  });

  assert.deepEqual(await client.checkVoiceCapabilities(), {
    transcription: 'unconfigured',
  });
});

test('rejects malformed voice capability responses with the active operation', async () => {
  const client = createMurmurApiClient({
    runtime: webRuntime,
    fetch: async () => Response.json({ transcription: 'unknown' }),
  });

  await assert.rejects(
    client.checkVoiceCapabilities(),
    (error: unknown) =>
      error instanceof MurmurApiError &&
      error.kind === 'invalid-response' &&
      error.operation === 'voice-capabilities' &&
      error.code === 'invalid_voice_capabilities_response' &&
      error.fallbackEligible,
  );
});

test('posts an exploration turn and validates its typed response', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const client = createMurmurApiClient({
    runtime: webRuntime,
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return Response.json({
        answer: 'It makes the listening context portable.',
        provider: 'openai',
        model: 'test-model',
      });
    },
  });

  const result = await client.exploreTurn(explorePayload);

  assert.equal(requestUrl, '/api/explore');
  assert.equal(requestInit?.method, 'POST');
  assert.equal(new Headers(requestInit?.headers).get('X-Murmur-Client'), 'expo');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), explorePayload);
  assert.equal(result.answer, 'It makes the listening context portable.');
});

test('preserves structured server errors for fallback decisions', async () => {
  const client = createMurmurApiClient({
    runtime: webRuntime,
    fetch: async () =>
      Response.json(
        {
          error: {
            code: 'provider_unavailable',
            message: 'The provider is temporarily unavailable.',
            retryable: true,
          },
        },
        { status: 503 },
      ),
  });

  await assert.rejects(
    client.exploreTurn(explorePayload),
    (error: unknown) =>
      error instanceof MurmurApiError &&
      error.kind === 'http' &&
      error.code === 'provider_unavailable' &&
      error.status === 503 &&
      error.retryable &&
      error.fallbackEligible,
  );
});

test('falls back when a provider is unconfigured without suggesting a retry', async () => {
  const client = createMurmurApiClient({
    runtime: webRuntime,
    fetch: async () =>
      Response.json(
        {
          error: {
            code: 'provider_not_configured',
            message: 'The provider is not configured.',
            retryable: false,
          },
        },
        { status: 503 },
      ),
  });

  await assert.rejects(
    client.exploreTurn(explorePayload),
    (error: unknown) =>
      error instanceof MurmurApiError &&
      !error.retryable &&
      error.fallbackEligible,
  );
});

test('labels native configuration failures with the active operation', async () => {
  const client = createMurmurApiClient({
    runtime: () => ({ platform: 'native' }),
  });

  await assert.rejects(
    client.synthesizeSpeech('Read this.'),
    (error: unknown) =>
      error instanceof MurmurApiError &&
      error.kind === 'configuration' &&
      error.operation === 'speech',
  );
});

test('keeps caller cancellation distinct from network and timeout failures', async () => {
  const controller = new AbortController();
  const client = createMurmurApiClient({
    runtime: webRuntime,
    fetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }),
  });

  const request = client.exploreTurn(explorePayload, controller.signal);
  controller.abort();

  await assert.rejects(
    request,
    (error: unknown) =>
      error instanceof MurmurApiError &&
      error.kind === 'cancelled' &&
      !error.fallbackEligible,
  );
});

test('times out hanging requests and marks them eligible for local fallback', async () => {
  const client = createMurmurApiClient({
    runtime: webRuntime,
    timeouts: { explore: 5 },
    fetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }),
  });

  await assert.rejects(
    client.exploreTurn(explorePayload),
    (error: unknown) =>
      error instanceof MurmurApiError &&
      error.kind === 'timeout' &&
      error.retryable &&
      error.fallbackEligible,
  );
});

test('uploads browser audio as multipart form data', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = createMurmurApiClient({
    runtime: webRuntime,
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).startsWith('blob:')) {
        return new Response(new Blob(['recording'], { type: 'audio/webm' }));
      }
      return Response.json({
        transcript: 'What did that mean?',
        provider: 'openai',
        model: 'test-transcriber',
      });
    },
  });

  const result = await client.transcribeRecording('blob:test-recording', {
    mimeType: 'audio/webm',
    name: 'question.webm',
  });

  assert.equal(calls[1]?.url, '/api/transcribe');
  assert.ok(calls[1]?.init?.body instanceof FormData);
  assert.ok((calls[1]?.init?.body as FormData).get('audio') instanceof Blob);
  assert.equal(result.transcript, 'What did that mean?');
});

test('uploads a real file-compatible object on native instead of a URI descriptor', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const recording = new Blob(['native recording'], { type: 'audio/mp4' });
  let loadedUri = '';
  const client = createMurmurApiClient({
    runtime: () => ({
      platform: 'native',
      development: true,
      expoHostUri: '192.168.1.218:8082',
    }),
    loadNativeRecordingFile: async (uri) => {
      loadedUri = uri;
      return recording;
    },
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({
        transcript: 'Play the second episode.',
        provider: 'openai',
        model: 'test-transcriber',
      });
    },
  });

  const result = await client.transcribeRecording(
    'file:///recordings/murmur-question.m4a',
    { mimeType: 'audio/mp4', name: 'murmur-question.m4a' },
  );

  assert.equal(loadedUri, 'file:///recordings/murmur-question.m4a');
  assert.equal(calls[0]?.url, 'http://192.168.1.218:8082/api/transcribe');
  assert.ok(calls[0]?.init?.body instanceof FormData);
  const uploadedRecording = (calls[0]?.init?.body as FormData).get('audio');
  assert.ok(uploadedRecording instanceof Blob);
  assert.equal(uploadedRecording.size, recording.size);
  assert.equal(uploadedRecording.type, recording.type);
  assert.equal((uploadedRecording as File).name, 'murmur-question.m4a');
  assert.equal(result.transcript, 'Play the second episode.');
});

test('reports an unreadable native recording without mislabeling it as a network outage', async () => {
  let fetchCalled = false;
  const client = createMurmurApiClient({
    runtime: () => ({
      platform: 'native',
      development: true,
      expoHostUri: '192.168.1.218:8082',
    }),
    loadNativeRecordingFile: async () => {
      throw new Error('File is gone');
    },
    fetch: async () => {
      fetchCalled = true;
      return Response.json({});
    },
  });

  await assert.rejects(
    client.transcribeRecording('file:///recordings/missing.m4a', {
      mimeType: 'audio/mp4',
      name: 'murmur-question.m4a',
    }),
    (error: unknown) =>
      error instanceof MurmurApiError &&
      error.kind === 'invalid-request' &&
      error.code === 'recording_unreadable' &&
      !error.retryable,
  );
  assert.equal(fetchCalled, false);
});

test('rejects an empty native recording before attempting the upload', async () => {
  let fetchCalled = false;
  const client = createMurmurApiClient({
    runtime: () => ({
      platform: 'native',
      development: true,
      expoHostUri: '192.168.1.218:8082',
    }),
    loadNativeRecordingFile: async () => new Blob([], { type: 'audio/mp4' }),
    fetch: async () => {
      fetchCalled = true;
      return Response.json({});
    },
  });

  await assert.rejects(
    client.transcribeRecording('file:///recordings/empty.m4a', {
      mimeType: 'audio/mp4',
      name: 'murmur-question.m4a',
    }),
    (error: unknown) =>
      error instanceof MurmurApiError &&
      error.kind === 'invalid-request' &&
      error.code === 'recording_unreadable' &&
      !error.retryable,
  );
  assert.equal(fetchCalled, false);
});

test('returns speech bytes with an explicit AI voice disclosure', async () => {
  const client = createMurmurApiClient({
    runtime: webRuntime,
    fetch: async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          'Content-Type': 'audio/mpeg',
          'X-Murmur-Model': 'test-voice',
          'X-Murmur-Voice-Disclosure': 'ai-generated',
        },
      }),
  });

  const result = await client.synthesizeSpeech('Here is the clarification.');

  assert.equal(result.audio.byteLength, 3);
  assert.equal(result.mimeType, 'audio/mpeg');
  assert.equal(result.model, 'test-voice');
  assert.equal(result.disclosure, 'ai-generated');
});

test('rejects speech audio that is not explicitly disclosed as AI-generated', async () => {
  const client = createMurmurApiClient({
    runtime: webRuntime,
    fetch: async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'Content-Type': 'audio/mpeg' },
      }),
  });

  await assert.rejects(
    client.synthesizeSpeech('Here is the clarification.'),
    (error: unknown) =>
      error instanceof MurmurApiError &&
      error.code === 'missing_voice_disclosure' &&
      error.fallbackEligible,
  );
});

test('classifies malformed successful responses instead of trusting them', async () => {
  const client = createMurmurApiClient({
    runtime: webRuntime,
    fetch: async () => Response.json({ answer: '' }),
  });

  await assert.rejects(
    client.exploreTurn(explorePayload),
    (error: unknown) =>
      error instanceof MurmurApiError &&
      error.kind === 'invalid-response' &&
      error.fallbackEligible,
  );
});
