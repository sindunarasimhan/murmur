import type { AudioApiErrorCode } from './contracts';
import { API_HEADERS, ApiError, apiFailure, apiJson, apiOptions } from '../http/api';

export const AUDIO_API_CORS_HEADERS = API_HEADERS;
export const audioApiJson = apiJson;
export const audioApiOptions = apiOptions;
export function audioApiError(code: AudioApiErrorCode, message: string, status: number): Response {
  return apiFailure(new ApiError(status, code, message));
}
