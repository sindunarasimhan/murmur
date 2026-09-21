import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';

import { resolveDiscoveryVoiceSelection } from '@/domain/discovery-voice-resolver';
import {
  resolveVerifiedAdSegment,
  routeVoiceIntent,
} from '@/domain/voice-intent';

type MarkerSidecar = {
  adEndSeconds: number;
  adStartSeconds: number;
  durationSeconds: number;
  versionId: string;
};

async function loadDemoEpisodeWithoutBundlingAssets() {
  const assetRequire = createRequire(import.meta.url);
  const previousWavLoader = assetRequire.extensions['.wav'];
  const previousPngLoader = assetRequire.extensions['.png'];
  const assetPathLoader: NodeJS.RequireExtensions[string] = (module, filename) => {
    module.exports = filename;
  };

  assetRequire.extensions['.wav'] = assetPathLoader;
  assetRequire.extensions['.png'] = assetPathLoader;

  try {
    return (await import('./demo-episode')).demoEpisode;
  } finally {
    if (previousWavLoader) assetRequire.extensions['.wav'] = previousWavLoader;
    else delete assetRequire.extensions['.wav'];
    if (previousPngLoader) assetRequire.extensions['.png'] = previousPngLoader;
    else delete assetRequire.extensions['.png'];
  }
}

test('binds the demo break markers to the exact bundled WAV bytes', () => {
  const audio = readFileSync(
    resolve(process.cwd(), 'assets/audio/murmur-handoff-demo.wav'),
  );
  const markers = JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'assets/audio/murmur-handoff-demo-markers.json'),
      'utf8',
    ),
  ) as MarkerSidecar;
  const versionId = `sha256-${createHash('sha256').update(audio).digest('hex').slice(0, 20)}`;

  assert.equal(markers.versionId, versionId);
  assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
  assert.equal(audio.toString('ascii', 8, 12), 'WAVE');

  const channels = audio.readUInt16LE(22);
  const sampleRate = audio.readUInt32LE(24);
  const bitsPerSample = audio.readUInt16LE(34);
  const dataLength = audio.readUInt32LE(40);
  const durationSeconds = dataLength / (sampleRate * channels * (bitsPerSample / 8));

  assert.equal(durationSeconds, markers.durationSeconds);
  assert.ok(markers.adStartSeconds >= 0);
  assert.ok(markers.adEndSeconds > markers.adStartSeconds);
  assert.ok(markers.adEndSeconds <= durationSeconds);
});

test('connects spoken selection and skip intent to the actual bundled demo marker', async () => {
  const demoEpisode = await loadDemoEpisodeWithoutBundlingAssets();

  assert.equal(demoEpisode.id, 'murmur-handoff-demo');
  assert.notEqual(demoEpisode.audioAsset.bundledSource, undefined);
  assert.deepEqual(
    resolveDiscoveryVoiceSelection({
      utterance: 'Play The Handoff',
      episodes: [demoEpisode],
    }),
    {
      kind: 'match',
      episode: demoEpisode,
      reason: 'episode-title',
    },
  );
  assert.deepEqual(routeVoiceIntent('skip ad'), {
    kind: 'command',
    command: 'skip-ad',
  });

  const resolved = resolveVerifiedAdSegment({
    assetIdentityKind: demoEpisode.audioAsset.identityKind,
    assetVersionId: demoEpisode.audioAsset.versionId,
    currentSeconds: 12,
    segments: demoEpisode.adSegments,
  });
  assert.equal(resolved.kind, 'resolved');
  if (resolved.kind === 'resolved') {
    assert.equal(resolved.seekToSeconds, 20);
    assert.equal(resolved.segment.id, 'demo-sponsor-break');
  }

  for (const currentSeconds of [0, 9.999, 20, 20.001]) {
    assert.deepEqual(
      resolveVerifiedAdSegment({
        assetIdentityKind: demoEpisode.audioAsset.identityKind,
        assetVersionId: demoEpisode.audioAsset.versionId,
        currentSeconds,
        segments: demoEpisode.adSegments,
      }),
      { kind: 'unavailable', reason: 'no-verified-segment' },
    );
  }
});
