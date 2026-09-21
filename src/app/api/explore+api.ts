import {
  handleExploreOptions,
  handleExplorePost,
} from '@/server/exploration/explore-handler';

export function OPTIONS(): Response {
  return handleExploreOptions();
}

export async function POST(request: Request): Promise<Response> {
  return handleExplorePost(request);
}
