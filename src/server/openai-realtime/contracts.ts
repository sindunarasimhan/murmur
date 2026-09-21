import { DEFAULT_MODELS } from '../config';

export const DEFAULT_REALTIME_TRANSCRIBE_MODEL = DEFAULT_MODELS.realtime;
export const REALTIME_SAMPLE_RATE = 24_000;

export type RealtimeSurface = 'discovery' | 'episode';

export type RealtimeTokenRequest = {
  surface: RealtimeSurface;
};

export type RealtimeTokenResponse = {
  clientSecret: string;
  expiresAt: number;
  model: string;
  sampleRate: number;
};

export type RealtimeTokenErrorCode =
  | 'invalid_client'
  | 'invalid_json'
  | 'invalid_content_type'
  | 'invalid_request'
  | 'payload_too_large'
  | 'request_cancelled'
  | 'provider_timeout'
  | 'provider_authentication'
  | 'provider_quota'
  | 'provider_unavailable'
  | 'invalid_surface'
  | 'openai_not_configured'
  | 'upstream_error';

export function isRealtimeSurface(value: unknown): value is RealtimeSurface {
  return value === 'discovery' || value === 'episode';
}
