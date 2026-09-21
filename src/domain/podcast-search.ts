import type { PodcastEpisode } from '@/domain/podcast';

export type PodcastSearchResult = {
  provider: 'apple-podcasts-rss';
  query: {
    directory: string;
    episode?: string;
    wantsLatest: boolean;
  };
  podcast: {
    directoryId: string;
    title: string;
    author?: string;
    feedUrl: string;
    artworkUrl?: string;
  };
  episode: PodcastEpisode;
};
