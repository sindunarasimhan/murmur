import type { CatalogEpisode, PodcastEpisode, PodcastFeed } from '@/domain/podcast';
import { demoEpisode } from '@/data/demo-episode';
import { fallbackFeed } from '@/data/fallback-catalog';
import { fetchPodcastFeed } from '@/services/rss/fetch-podcast-feed';

const podcastingEditorialArtwork = [
  require('../../assets/images/podcasting-editorial-cover.png'),
  require('../../assets/images/podcasting-editorial-cover-warm.png'),
  require('../../assets/images/podcasting-editorial-cover-violet.png'),
] as const;

const episodePalettes = [
  { accent: '#8FB9DC', accentSoft: '#243D56', eyebrow: 'New signal' },
  { accent: '#D989A5', accentSoft: '#512638', eyebrow: 'For your curiosity' },
  { accent: '#8DB7A2', accentSoft: '#244239', eyebrow: 'Go deeper' },
  { accent: '#E39A68', accentSoft: '#583320', eyebrow: 'A different angle' },
  { accent: '#AFA0FF', accentSoft: '#302A59', eyebrow: 'Worth your time' },
] as const;

export type CatalogSnapshot = {
  feed: PodcastFeed;
  episodes: CatalogEpisode[];
  source: 'live-rss' | 'seed-catalog';
  warning?: string;
};

export function decorateRemoteEpisode(
  episode: PodcastEpisode,
  index = 0,
): CatalogEpisode {
  const palette = episodePalettes[index % episodePalettes.length] ?? episodePalettes[0];
  return { ...episode, ...palette };
}

function decorate(feed: PodcastFeed): CatalogEpisode[] {
  return feed.episodes.slice(0, 8).map((episode, index) => {
    return {
      ...decorateRemoteEpisode(episode, index),
      bundledArtworkSource:
        podcastingEditorialArtwork[index % podcastingEditorialArtwork.length],
    };
  });
}

export async function loadCatalog(signal?: AbortSignal): Promise<CatalogSnapshot> {
  try {
    const feed = await fetchPodcastFeed(signal);
    if (feed.episodes.length === 0) throw new Error('The RSS feed has no playable episodes.');
    return { feed, episodes: [demoEpisode, ...decorate(feed).slice(0, 7)], source: 'live-rss' };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      feed: fallbackFeed,
      episodes: [demoEpisode, ...decorate(fallbackFeed).slice(0, 7)],
      source: 'seed-catalog',
      warning: error instanceof Error ? error.message : 'The live RSS feed is unavailable.',
    };
  }
}
