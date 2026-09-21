import type { PodcastFeed } from '@/domain/podcast';

export const DEVELOPMENT_FEED_URL =
  'https://feeds.truefans.fm/rss/6750170d97d4af53ccbaec06/';

/**
 * Network-independent catalog metadata. The only playable fallback episode is
 * the bundled Murmur demo, which the repository adds separately.
 */
export const fallbackFeed: PodcastFeed = {
  id: 'murmur-development-seed',
  feedUrl: DEVELOPMENT_FEED_URL,
  title: 'Murmur development catalog',
  description:
    'The live RSS source is unavailable. The bundled Murmur handoff demo remains playable.',
  author: 'Murmur',
  language: 'en',
  episodes: [],
};
