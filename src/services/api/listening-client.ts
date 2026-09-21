import { z } from 'zod';
import { catalogResolutionSchema, episodeSchema, sessionSchema, turnResultSchema, type ListeningSession, type Observation, type TurnRequest } from '../../../shared/listening';
import { resolveApiBaseUrl, resolveExpoDevelopmentHostUri, type SynthesizedSpeech } from './murmur-api-client';

export class ListeningApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}
function runtime() {
  if (process.env.EXPO_OS === 'web' || typeof document !== 'undefined') return { platform: 'web' as const };
  // Keep native modules outside Node contract tests.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const constants = require('expo-constants').default;
  return { platform: 'native' as const, configuredBaseUrl: process.env.EXPO_PUBLIC_API_URL,
    development: typeof __DEV__ !== 'undefined' && __DEV__, expoHostUri: resolveExpoDevelopmentHostUri(constants) };
}
export function listeningBaseUrl() { return `${resolveApiBaseUrl(runtime())}/v2`; }
export function voiceGatewayUrl() {
  const configured = process.env.EXPO_PUBLIC_MURMUR_VOICE_URL;
  if (configured) {
    const url = new URL(configured);
    if (!['wss:', 'ws:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid voice gateway address');
    if (url.protocol === 'ws:' && typeof __DEV__ !== 'undefined' && !__DEV__) throw new Error('Voice requires a secure connection');
    return configured;
  }
  const current = runtime();
  if (current.platform === 'web') return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.hostname}:4545/v2/voice`;
  if (!current.development) throw new Error('Set the voice gateway address for this build.');
  const url = new URL(listeningBaseUrl());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.port = '4545'; url.pathname = '/v2/voice';
  return url.toString();
}
const TOKEN_KEY = 'murmur-listening-identity';
let token: string | undefined;
let initialization: Promise<void> | undefined;
async function raw(path: string, method: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(`${listeningBaseUrl()}${path}`, {
    method, credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-Murmur-Client': 'v2', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new ListeningApiError(result.error?.message ?? 'The listening service is unavailable.', response.status, result.error?.code ?? 'request_failed');
  }
  return response;
}
async function identity() {
  if (!initialization) initialization = (async () => {
    const native = runtime().platform === 'native';
    if (native) token = (await import('expo-secure-store')).getItem(TOKEN_KEY) ?? undefined;
    const result = z.object({ id: z.uuid(), token: z.string().optional() }).parse(await (await raw('/identity', 'POST', {})).json());
    if (native && result.token) {
      token = result.token;
      await (await import('expo-secure-store')).setItemAsync(TOKEN_KEY, token);
    }
  })().catch((error) => { initialization = undefined; throw error; });
  return initialization;
}
async function json<T>(path: string, method: string, schema: z.ZodType<T>, body?: unknown, signal?: AbortSignal): Promise<T> {
  await identity();
  try { return schema.parse(await (await raw(path, method, body, signal)).json()); }
  catch (error) { if (error instanceof ListeningApiError && error.status === 401) initialization = undefined; throw error; }
}
export const listeningApi = {
  catalog: (signal?: AbortSignal) => json('/catalog', 'GET', z.array(episodeSchema), undefined, signal),
  resolve: (utterance: string, currentEpisodeId: string | undefined, history: string[], signal?: AbortSignal) => json('/catalog/resolve', 'POST', catalogResolutionSchema, { utterance, currentEpisodeId, history }, signal),
  liveTicket: (signal?: AbortSignal) => json('/live-voice-ticket', 'POST', z.object({ token: z.string(), leaseMilliseconds: z.number() }), {}, signal),
  episode: (signal?: AbortSignal) => json('/episode', 'GET', episodeSchema, undefined, signal),
  open: (episodeId: string) => json('/sessions', 'POST', sessionSchema, { episodeId }),
  session: (id: string) => json(`/sessions/${id}`, 'GET', sessionSchema),
  observe: (session: ListeningSession, reason: Observation['reason'], positionSeconds: number) => json(`/sessions/${session.id}/observations`, 'POST', sessionSchema, { revision: session.revision, audioVersion: session.audioVersion, positionSeconds, reason }),
  turn: (session: ListeningSession, utterance: string, positionSeconds: number, requestId: string, signal?: AbortSignal, resumeAfterAction?: boolean) => json(`/sessions/${session.id}/turns`, 'POST', turnResultSchema, { revision: session.revision, audioVersion: session.audioVersion, positionSeconds, utterance, requestId, resumeAfterAction } satisfies TurnRequest, signal),
  acknowledge: (session: ListeningSession, actionId: string, positionSeconds: number) => json(`/sessions/${session.id}/acknowledgements`, 'POST', sessionSchema, { revision: session.revision, audioVersion: session.audioVersion, positionSeconds, actionId }),
  ticket: (id: string, signal?: AbortSignal) => json(`/sessions/${id}/voice-ticket`, 'POST', z.object({ clientSecret: z.string(), expiresAt: z.number(), model: z.string(), sampleRate: z.number() }), {}, signal),
  async speech(id: string, turnId: string, signal?: AbortSignal): Promise<SynthesizedSpeech> {
    await identity();
    const response = await raw(`/sessions/${id}/turns/${turnId}/speech`, 'POST', {}, signal);
    if (response.headers.get('X-Murmur-Voice-Disclosure') !== 'ai-generated') throw new Error('Speech disclosure is missing');
    return { audio: await response.arrayBuffer(), mimeType: 'audio/mpeg', disclosure: 'ai-generated' };
  },
};
