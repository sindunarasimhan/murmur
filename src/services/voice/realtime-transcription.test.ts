import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizePcm16,
  RealtimeTranscriptionSession,
} from '@/services/voice/realtime-transcription';
import { MurmurApiError } from '@/services/api/murmur-api-client';

class FakeWebSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  failOpen(): void {
    this.onerror?.();
  }

  emit(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    if (code !== 1000 && (code < 3000 || code > 4999)) throw new Error('Invalid browser WebSocket close code');
    this.closed = true;
    this.readyState = 3;
  }
}

test('normalizes stereo PCM16 to mono and requested sample rate', () => {
  const stereo = new Int16Array([
    10_000, 0,
    20_000, 0,
    30_000, 0,
    10_000, 0,
  ]);
  const normalized = normalizePcm16(stereo.buffer, 48_000, 2, 24_000);
  const samples = new Int16Array(normalized.buffer);

  assert.equal(samples.length, 2);
  assert.equal(samples[0], 5_000);
  assert.equal(samples[1], 15_000);
});

test('streams PCM chunks and emits partial and final transcripts', async () => {
  const socket = new FakeWebSocket();
  const partials: string[] = [];
  let final = '';
  let url = '';
  let protocols: readonly string[] = [];
  const session = new RealtimeTranscriptionSession(
    {
      onPartialTranscript: (transcript) => partials.push(transcript),
      onFinalTranscript: (transcript) => {
        final = transcript;
      },
    },
    {
      createToken: async () => ({
        clientSecret: 'ek_test',
        expiresAt: 123,
        model: 'test model',
        sampleRate: 24_000,
      }),
      createWebSocket: (nextUrl, nextProtocols) => {
        url = nextUrl;
        protocols = nextProtocols;
        queueMicrotask(() => socket.open());
        return socket;
      },
    },
  );

  await session.connect('discovery');
  assert.equal(url, 'wss://api.openai.com/v1/realtime');
  assert.deepEqual(protocols, ['realtime', 'openai-insecure-api-key.ek_test']);

  session.appendPcm(new Int16Array([1, 2, 3]).buffer, 24_000, 1);
  const append = JSON.parse(socket.sent[0] ?? '{}');
  assert.equal(append.type, 'input_audio_buffer.append');
  assert.equal(typeof append.audio, 'string');
  assert.ok(append.audio.length > 0);

  socket.emit({
    type: 'conversation.item.input_audio_transcription.delta',
    delta: 'Play ',
  });
  socket.emit({
    type: 'conversation.item.input_audio_transcription.delta',
    delta: 'The Daily',
  });
  socket.emit({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'Play The Daily',
  });

  assert.deepEqual(partials, ['Play ', 'Play The Daily']);
  assert.equal(final, 'Play The Daily');
});

test('retries one transient token request before opening live voice', async () => {
  const socket = new FakeWebSocket();
  let tokenRequests = 0;
  const session = new RealtimeTranscriptionSession({}, {
    createToken: async () => {
      tokenRequests += 1;
      if (tokenRequests === 1) {
        throw new MurmurApiError('The token route was still warming up.', {
          kind: 'timeout',
          operation: 'realtime-token',
          code: 'request_timeout',
          retryable: true,
          fallbackEligible: true,
        });
      }
      return {
        clientSecret: 'ek_test',
        expiresAt: 123,
        model: 'test-model',
        sampleRate: 24_000,
      };
    },
    createWebSocket: () => {
      queueMicrotask(() => socket.open());
      return socket;
    },
    wait: async () => undefined,
  });

  await session.connect('discovery');
  assert.equal(tokenRequests, 2);
  assert.equal(socket.readyState, 1);
});

test('retries one socket failure with a fresh token and connection', async () => {
  const sockets = [new FakeWebSocket(), new FakeWebSocket()];
  let tokenRequests = 0;
  let socketRequests = 0;
  let connected = 0;
  const session = new RealtimeTranscriptionSession(
    { onConnected: () => connected += 1 },
    {
      createToken: async () => ({
        clientSecret: `ek_test_${++tokenRequests}`,
        expiresAt: 123,
        model: 'test-model',
        sampleRate: 24_000,
      }),
      createWebSocket: () => {
        const socket = sockets[socketRequests++]!;
        queueMicrotask(() => {
          if (socketRequests === 1) socket.failOpen();
          else socket.open();
        });
        return socket;
      },
      wait: async () => undefined,
    },
  );

  await session.connect('episode');
  assert.equal(tokenRequests, 2);
  assert.equal(socketRequests, 2);
  assert.equal(sockets[0]?.closed, true);
  assert.equal(sockets[1]?.readyState, 1);
  assert.equal(connected, 1);
});

test('manual finish commits the live input buffer and resolves on completion', async () => {
  const socket = new FakeWebSocket();
  const session = new RealtimeTranscriptionSession({}, {
    createToken: async () => ({
      clientSecret: 'ek_test',
      expiresAt: 123,
      model: 'test-model',
      sampleRate: 24_000,
    }),
    createWebSocket: () => {
      queueMicrotask(() => socket.open());
      return socket;
    },
  });
  await session.connect('episode');

  const finished = session.finish();
  assert.equal(JSON.parse(socket.sent[0] ?? '{}').type, 'input_audio_buffer.commit');
  socket.emit({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'skip ad',
  });
  assert.equal(await finished, 'skip ad');
});

test('a gateway error closes cleanly and rejects the pending utterance', async () => {
  const socket = new FakeWebSocket();
  const errors: string[] = [];
  const session = new RealtimeTranscriptionSession({ onError: error => errors.push(error.message) }, {
    createToken: async () => ({ clientSecret: 'test', expiresAt: 123, model: 'test', sampleRate: 24_000 }),
    createWebSocket: () => { queueMicrotask(() => socket.open()); return socket; },
  });
  await session.connect('episode');
  const rejected = assert.rejects(session.finish(), /voice window ended/);
  assert.doesNotThrow(() => socket.emit({ type: 'error', error: { code: 'voice_unavailable', message: 'The voice window ended.' } }));
  await rejected;
  assert.equal(socket.closed, true);
  assert.deepEqual(errors, ['The voice window ended.']);
  assert.doesNotThrow(() => session.cancel());
});

test('clears uncommitted wake-listening audio and partial transcript state', async () => {
  const socket = new FakeWebSocket();
  const partials: string[] = [];
  const session = new RealtimeTranscriptionSession(
    {
      onPartialTranscript: (transcript) => partials.push(transcript),
    },
    {
      createToken: async () => ({
        clientSecret: 'ek_test',
        expiresAt: 123,
        model: 'test-model',
        sampleRate: 24_000,
      }),
      createWebSocket: () => {
        queueMicrotask(() => socket.open());
        return socket;
      },
    },
  );
  await session.connect('episode');

  socket.emit({
    type: 'conversation.item.input_audio_transcription.delta',
    delta: 'ordinary background speech',
  });
  session.clearInputBuffer();
  socket.emit({
    type: 'conversation.item.input_audio_transcription.delta',
    delta: 'Hey Murmur',
  });

  assert.equal(JSON.parse(socket.sent[0] ?? '{}').type, 'input_audio_buffer.clear');
  assert.deepEqual(partials, ['ordinary background speech', 'Hey Murmur']);
});
