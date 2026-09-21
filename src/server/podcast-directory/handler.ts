import { API_HEADERS, ApiError, apiBoundary, apiJson, apiOptions, readRequestJson, requireClient, requireJson } from '../http/api';
import { isRecord } from '../http/upstream';
import { discoverEpisode } from './discovery-service';

export const PODCAST_SEARCH_CORS_HEADERS = API_HEADERS;
type HandlerDependencies = { fetch?: typeof fetch };

export function handlePodcastSearchPost(request: Request, dependencies: HandlerDependencies = {}): Promise<Response> {
  return apiBoundary(async () => {
    requireClient(request);
    requireJson(request);
    const input = await readRequestJson(request, 2048);
    const query = isRecord(input) && typeof input.query === 'string' ? input.query.trim() : '';
    if (!query || query.length > 240) throw new ApiError(400, 'invalid_query', 'Podcast search must be between 1 and 240 characters.');
    return apiJson(await discoverEpisode(query, { fetch: dependencies.fetch, signal: request.signal }));
  });
}

export const handlePodcastSearchOptions = apiOptions;
