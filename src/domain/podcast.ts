export type TranscriptKind = 'json' | 'srt' | 'text' | 'vtt' | 'unknown';

export type TranscriptSource = {
  url: string;
  mimeType: string;
  language?: string;
  relation?: string;
  kind: TranscriptKind;
  isTimed: boolean;
};

export type TranscriptCue = {
  id: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
  speaker?: string;
};

export type AudioAsset = {
  url: string;
  bundledSource?: number;
  mimeType?: string;
  byteLength?: number;
  identityKind: 'content-hash' | 'feed-locator' | 'publisher-version';
  versionId: string;
};

export type AdSegment = {
  id: string;
  assetVersionId: string;
  startSeconds: number;
  endSeconds: number;
  label: string;
  source: 'detector' | 'manual' | 'publisher';
  confidence: number;
  verified: boolean;
};

export type PodcastEpisode = {
  id: string;
  guid: string;
  podcastTitle: string;
  title: string;
  description: string;
  publishedAt?: string;
  durationSeconds?: number;
  audioAsset: AudioAsset;
  artworkUrl?: string;
  bundledArtworkSource?: number;
  transcriptSources: TranscriptSource[];
  transcript?: TranscriptCue[];
  adSegments: AdSegment[];
};

export type PodcastFeed = {
  id: string;
  feedUrl: string;
  title: string;
  description: string;
  author?: string;
  copyright?: string;
  license?: string;
  language?: string;
  artworkUrl?: string;
  episodes: PodcastEpisode[];
};

export type CatalogEpisode = PodcastEpisode & {
  accent: string;
  accentSoft: string;
  eyebrow: string;
};
