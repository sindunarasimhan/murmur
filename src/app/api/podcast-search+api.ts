import {
  handlePodcastSearchOptions,
  handlePodcastSearchPost,
} from '@/server/podcast-directory/handler';

export function OPTIONS(): Response {
  return handlePodcastSearchOptions();
}

export async function POST(request: Request): Promise<Response> {
  return handlePodcastSearchPost(request);
}
