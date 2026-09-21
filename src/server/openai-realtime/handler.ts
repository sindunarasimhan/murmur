import { getServerConfig } from '../config';
import { ApiError, apiBoundary, apiJson, apiOptions, readRequestJson, requireClient, requireJson } from '../http/api';
import { isRecord } from '../http/upstream';
import { isRealtimeSurface } from './contracts';
import { createTranscriptionSession } from './provider';

type RealtimeHandlerDependencies = { apiKey?: string; fetch?: typeof fetch; model?: string };
export const realtimeTokenOptions = apiOptions;

export function handleRealtimeTokenRequest(request: Request, dependencies: RealtimeHandlerDependencies = {}): Promise<Response> {
  return apiBoundary(async () => {
    requireClient(request);
    requireJson(request);
    const input = await readRequestJson(request, 2048);
    if (!isRecord(input) || !isRealtimeSurface(input.surface) || Object.keys(input).some(key => key !== 'surface')) {
      throw new ApiError(400, 'invalid_surface', 'Choose either the discovery or episode voice surface.');
    }
    const config = getServerConfig().openai;
    const apiKey = (dependencies.apiKey ?? config.apiKey)?.trim();
    if (!apiKey) throw new ApiError(503, 'openai_not_configured', 'Realtime voice is temporarily unavailable.');
    const session = await createTranscriptionSession(input.surface, {
      apiKey, model: dependencies.model?.trim() || config.realtimeModel,
      fetch: dependencies.fetch, signal: request.signal,
    });
    return apiJson(session);
  });
}
