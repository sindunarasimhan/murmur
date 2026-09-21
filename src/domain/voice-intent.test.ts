import assert from 'node:assert/strict';
import test from 'node:test';

import type { AdSegment } from '@/domain/podcast';
import {
  resolveVerifiedAdSegment,
  routeVoiceIntent,
} from '@/domain/voice-intent';

test('routes explicit skip-ad requests, including polite requests', () => {
  assert.deepEqual(routeVoiceIntent('Skip this ad.'), {
    kind: 'command',
    command: 'skip-ad',
  });
  assert.deepEqual(routeVoiceIntent('Could you please jump past the commercial?'), {
    kind: 'command',
    command: 'skip-ad',
  });
});

test('does not mistake questions containing skip-ad words for commands', () => {
  assert.deepEqual(routeVoiceIntent('Why do podcasts skip ads?'), {
    kind: 'inquiry',
    category: 'clarify',
  });
  assert.deepEqual(routeVoiceIntent('Should I skip this ad?'), {
    kind: 'inquiry',
    category: 'clarify',
  });
  assert.deepEqual(routeVoiceIntent('Can you tell me why this show has ads?'), {
    kind: 'inquiry',
    category: 'clarify',
  });
});

test('routes only explicit play and pause commands', () => {
  assert.deepEqual(routeVoiceIntent('resume the episode'), {
    kind: 'command',
    command: 'play',
  });
  assert.deepEqual(routeVoiceIntent('please pause playback'), {
    kind: 'command',
    command: 'pause',
  });
  assert.deepEqual(routeVoiceIntent('Would the host pause here?'), {
    kind: 'inquiry',
    category: 'clarify',
  });
  assert.deepEqual(routeVoiceIntent('stop'), { kind: 'unknown' });
});

test('routes bounded forward and backward relative seeks', () => {
  assert.deepEqual(routeVoiceIntent('go forward 30 seconds'), {
    kind: 'command',
    command: 'seek-relative',
    deltaSeconds: 30,
  });
  assert.deepEqual(routeVoiceIntent('rewind by one minute'), {
    kind: 'command',
    command: 'seek-relative',
    deltaSeconds: -60,
  });
  assert.deepEqual(routeVoiceIntent('Could you skip ahead forty five seconds?'), {
    kind: 'command',
    command: 'seek-relative',
    deltaSeconds: 45,
  });
  assert.deepEqual(routeVoiceIntent('back half a minute'), {
    kind: 'command',
    command: 'seek-relative',
    deltaSeconds: -30,
  });
});

test('refuses ambiguous, invalid, and unbounded seek requests', () => {
  assert.deepEqual(routeVoiceIntent('skip ahead'), { kind: 'unknown' });
  assert.deepEqual(routeVoiceIntent('go back zero seconds'), { kind: 'unknown' });
  assert.deepEqual(routeVoiceIntent('go forward banana seconds'), {
    kind: 'unknown',
  });
  assert.deepEqual(routeVoiceIntent('go forward one one seconds'), {
    kind: 'unknown',
  });
  assert.deepEqual(routeVoiceIntent('go forward 2 hours'), { kind: 'unknown' });
});

test('classifies supported inquiry categories', () => {
  assert.deepEqual(routeVoiceIntent('What does that term mean?'), {
    kind: 'inquiry',
    category: 'clarify',
  });
  assert.deepEqual(routeVoiceIntent('Who was the researcher they cited?'), {
    kind: 'inquiry',
    category: 'factual',
  });
  assert.deepEqual(routeVoiceIntent('Can you tell me who they cited?'), {
    kind: 'inquiry',
    category: 'factual',
  });
  assert.deepEqual(routeVoiceIntent('Do those numbers add up?'), {
    kind: 'inquiry',
    category: 'quantitative',
  });
  assert.deepEqual(routeVoiceIntent('Argue the strongest case against that claim.'), {
    kind: 'inquiry',
    category: 'debate',
  });
  assert.deepEqual(routeVoiceIntent('Make the strongest case for the other side.'), {
    kind: 'inquiry',
    category: 'debate',
  });
  assert.deepEqual(routeVoiceIntent('What does this imply about identity?'), {
    kind: 'inquiry',
    category: 'abstract',
  });
});

test('returns unknown for empty or non-actionable statements', () => {
  assert.deepEqual(routeVoiceIntent('   '), { kind: 'unknown' });
  assert.deepEqual(routeVoiceIntent('interesting episode'), { kind: 'unknown' });
});

function adSegment(overrides: Partial<AdSegment> = {}): AdSegment {
  return {
    id: 'ad-1',
    assetVersionId: 'asset-v1',
    startSeconds: 60,
    endSeconds: 90,
    label: 'Sponsor break',
    source: 'manual',
    confidence: 1,
    verified: true,
    ...overrides,
  };
}

test('resolves a verified marker for the exact asset at an in-range position', () => {
  const segment = adSegment();

  assert.deepEqual(
    resolveVerifiedAdSegment({
      assetIdentityKind: 'content-hash',
      assetVersionId: 'asset-v1',
      currentSeconds: 72,
      segments: [segment],
    }),
    {
      kind: 'resolved',
      seekToSeconds: 90,
      segment,
    },
  );
});

test('treats ad ranges as start-inclusive and end-exclusive', () => {
  const segment = adSegment();

  assert.equal(
    resolveVerifiedAdSegment({
      assetIdentityKind: 'content-hash',
      assetVersionId: 'asset-v1',
      currentSeconds: 60,
      segments: [segment],
    }).kind,
    'resolved',
  );
  assert.deepEqual(
    resolveVerifiedAdSegment({
      assetIdentityKind: 'content-hash',
      assetVersionId: 'asset-v1',
      currentSeconds: 90,
      segments: [segment],
    }),
    { kind: 'unavailable', reason: 'no-verified-segment' },
  );
});

test('fails closed for a different asset version', () => {
  assert.deepEqual(
    resolveVerifiedAdSegment({
      assetIdentityKind: 'content-hash',
      assetVersionId: 'asset-v2',
      currentSeconds: 72,
      segments: [adSegment()],
    }),
    { kind: 'unavailable', reason: 'no-verified-segment' },
  );
});

test('fails closed for unverified, low-confidence, or malformed markers', () => {
  const unsafeSegments = [
    adSegment({ id: 'unverified', verified: false }),
    adSegment({ id: 'low-confidence', confidence: 0.94 }),
    adSegment({ id: 'reversed', startSeconds: 90, endSeconds: 60 }),
    adSegment({ id: 'invalid-confidence', confidence: 1.1 }),
  ];

  assert.deepEqual(
    resolveVerifiedAdSegment({
      assetIdentityKind: 'content-hash',
      assetVersionId: 'asset-v1',
      currentSeconds: 72,
      segments: unsafeSegments,
    }),
    { kind: 'unavailable', reason: 'no-verified-segment' },
  );
});

test('supports an explicit confidence threshold', () => {
  const segment = adSegment({ confidence: 0.8 });

  assert.equal(
    resolveVerifiedAdSegment({
      assetIdentityKind: 'content-hash',
      assetVersionId: 'asset-v1',
      currentSeconds: 72,
      segments: [segment],
      minimumConfidence: 0.8,
    }).kind,
    'resolved',
  );
});

test('fails closed when multiple verified markers contain the position', () => {
  assert.deepEqual(
    resolveVerifiedAdSegment({
      assetIdentityKind: 'content-hash',
      assetVersionId: 'asset-v1',
      currentSeconds: 75,
      segments: [
        adSegment(),
        adSegment({ id: 'ad-2', startSeconds: 70, endSeconds: 100 }),
      ],
    }),
    { kind: 'unavailable', reason: 'ambiguous-segments' },
  );
});

test('rejects invalid resolution requests and threshold configuration', () => {
  assert.deepEqual(
    resolveVerifiedAdSegment({
      assetIdentityKind: 'content-hash',
      assetVersionId: '',
      currentSeconds: 72,
      segments: [adSegment()],
    }),
    { kind: 'unavailable', reason: 'invalid-request' },
  );
  assert.deepEqual(
    resolveVerifiedAdSegment({
      assetIdentityKind: 'content-hash',
      assetVersionId: 'asset-v1',
      currentSeconds: Number.NaN,
      segments: [adSegment()],
    }),
    { kind: 'unavailable', reason: 'invalid-request' },
  );
  assert.throws(
    () =>
      resolveVerifiedAdSegment({
        assetIdentityKind: 'content-hash',
        assetVersionId: 'asset-v1',
        currentSeconds: 72,
        segments: [adSegment()],
        minimumConfidence: 1.1,
      }),
    /between 0 and 1/,
  );
});

test('fails closed when the asset only has mutable feed identity', () => {
  assert.deepEqual(
    resolveVerifiedAdSegment({
      assetIdentityKind: 'feed-locator',
      assetVersionId: 'asset-v1',
      currentSeconds: 72,
      segments: [adSegment()],
    }),
    { kind: 'unavailable', reason: 'invalid-request' },
  );
});
