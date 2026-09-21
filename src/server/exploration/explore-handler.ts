import { getServerConfig, type ServerEnvironment } from '../config';
import { API_HEADERS, ApiError, apiBoundary, apiJson, apiOptions, readRequestJson, requireClient, requireJson } from '../http/api';
import { EXPLORE_LIMITS } from './explore-contract';
import { validateExploreRequest } from './explore-validation';
import { answerQuestion } from './answer-service';

export const EXPLORE_CORS_HEADERS = API_HEADERS;
type HandlerDependencies = { apiKey?: string; model?: string; fetchImpl?: typeof fetch; environment?: ServerEnvironment };

export function handleExplorePost(request: Request, dependencies: HandlerDependencies = {}): Promise<Response> {
  return apiBoundary(async () => {
    requireClient(request, 'invalid_request');
    requireJson(request, 400, 'invalid_request');
    const validation = validateExploreRequest(await readRequestJson(request, EXPLORE_LIMITS.bodyBytes));
    if (!validation.ok) throw new ApiError(400, 'invalid_request', validation.message);
    const config = getServerConfig({
      ...(dependencies.environment ?? process.env),
      ...(dependencies.apiKey !== undefined ? { OPENAI_API_KEY: dependencies.apiKey } : {}),
      ...(dependencies.model !== undefined ? { OPENAI_RESPONSE_MODEL: dependencies.model } : {}),
    });
    if (!config.openai.apiKey) throw new ApiError(503, 'provider_not_configured', 'Murmur answers are not configured on this server.');
    const result = await answerQuestion(validation.value, { config, fetch: dependencies.fetchImpl, signal: request.signal });
    return apiJson({ answer: result.answer, provider: 'openai', model: result.model }, 200, {
      'X-Murmur-Decision': result.decision,
    });
  });
}

export const handleExploreOptions = apiOptions;
