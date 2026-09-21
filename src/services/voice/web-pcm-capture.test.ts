import assert from 'node:assert/strict';
import test from 'node:test';

import {
  float32ToPcm16,
  normalizeWebPcmCaptureError,
  resolveWebPcmCaptureAvailability,
} from '@/services/voice/web-pcm-capture';

test('converts browser float samples to signed PCM16', () => {
  const output = new Int16Array(
    float32ToPcm16(new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2])),
  );

  assert.deepEqual([...output], [
    -32768,
    -32768,
    -16384,
    0,
    16384,
    32767,
    32767,
  ]);
});

test('rejects plain LAN HTTP before attempting browser microphone capture', () => {
  assert.deepEqual(
    resolveWebPcmCaptureAvailability({
      protocol: 'http:',
      hostname: '192.168.1.218',
      hasGetUserMedia: false,
      hasAudioContext: true,
    }),
    { available: false, reason: 'insecure-context' },
  );
});

test('distinguishes an embedded preview without microphone support', () => {
  assert.deepEqual(
    resolveWebPcmCaptureAvailability({
      protocol: 'http:',
      hostname: 'localhost',
      hasGetUserMedia: false,
      hasAudioContext: true,
    }),
    { available: false, reason: 'microphone-unavailable' },
  );
});

test('allows microphone capture on localhost or HTTPS', () => {
  for (const environment of [
    {
      protocol: 'http:',
      hostname: 'localhost',
      hasGetUserMedia: true,
      hasAudioContext: true,
    },
    {
      protocol: 'https:',
      hostname: 'preview.example.com',
      hasGetUserMedia: true,
      hasAudioContext: true,
    },
  ]) {
    assert.deepEqual(resolveWebPcmCaptureAvailability(environment), { available: true });
  }
});

test('distinguishes permission denial from a transient busy microphone', () => {
  assert.equal(
    normalizeWebPcmCaptureError(new DOMException('denied', 'NotAllowedError')).code,
    'microphone-denied',
  );
  assert.equal(
    normalizeWebPcmCaptureError(new DOMException('busy', 'NotReadableError')).code,
    'microphone-busy',
  );
  assert.equal(
    normalizeWebPcmCaptureError(new Error('unknown')).code,
    'microphone-failed',
  );
});
