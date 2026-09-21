import demoMarkers from '../../assets/audio/murmur-handoff-demo-markers.json';
import type { CatalogEpisode } from '@/domain/podcast';

export const demoEpisode: CatalogEpisode = {
  id: 'murmur-handoff-demo',
  guid: 'murmur-handoff-demo-v1',
  podcastTitle: 'Murmur Field Notes',
  title: 'The Handoff',
  description:
    'A programmatically generated test signal with one exact break boundary and timed context.',
  durationSeconds: demoMarkers.durationSeconds,
  audioAsset: {
    url: 'murmur://handoff-demo-v1',
    bundledSource: require('../../assets/audio/murmur-handoff-demo.wav'),
    mimeType: 'audio/wav',
    identityKind: 'content-hash',
    versionId: demoMarkers.versionId,
  },
  bundledArtworkSource: require('../../assets/images/handoff-editorial-cover.png'),
  transcriptSources: [],
  transcript: [
    {
      id: 'demo-intro',
      startSeconds: 0,
      endSeconds: demoMarkers.adStartSeconds,
      text:
        '[Warm synthesized tones represent the podcast signal.]',
    },
    {
      id: 'demo-sponsor',
      startSeconds: demoMarkers.adStartSeconds,
      endSeconds: demoMarkers.adEndSeconds,
      text:
        '[Bright repeating tones mark the verified demonstration break.]',
    },
    {
      id: 'demo-return',
      startSeconds: demoMarkers.adEndSeconds,
      endSeconds: demoMarkers.durationSeconds,
      text:
        '[The warm synthesized podcast signal returns after the verified boundary.]',
    },
  ],
  adSegments: [
    {
      id: 'demo-sponsor-break',
      assetVersionId: demoMarkers.versionId,
      startSeconds: demoMarkers.adStartSeconds,
      endSeconds: demoMarkers.adEndSeconds,
      label: 'Demonstration sponsor break',
      source: 'manual',
      confidence: 1,
      verified: true,
    },
  ],
  accent: '#E9A267',
  accentSoft: '#59331F',
  eyebrow: 'Murmur original',
};
