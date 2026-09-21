import type { PodcastEpisode } from '@/domain/podcast';
import type { PodcastSearchResult } from '@/domain/podcast-search';
import type { InquiryCategory } from '@/domain/voice-intent';

export type ExploreTurnPayload = {
  question: string;
  intent: InquiryCategory;
  episode: {
    title: string;
    showTitle: string;
  };
  playbackPositionSeconds: number;
  transcriptContext: string;
  history?: readonly {
    question: string;
    answer: string;
  }[];
};

export type ExploreTurnResult = {
  answer: string;
  provider: 'openai';
  model: string;
};

export type RecordingMetadata = {
  mimeType: string;
  name: string;
};

export type TranscriptionResult = {
  transcript: string;
  provider: 'openai';
  model: string;
};

export type VoiceCapabilitiesResult = {
  transcription: 'ready' | 'unconfigured';
};

export type RealtimeVoiceSurface = 'discovery' | 'episode';

export type RealtimeSessionToken = {
  clientSecret: string;
  expiresAt: number;
  model: string;
  sampleRate: number;
};

export type SynthesizedSpeech = {
  audio: ArrayBuffer;
  mimeType: string;
  model?: string;
  disclosure: 'ai-generated';
};

export type RequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type RequestControl = AbortSignal | RequestOptions;

export type ApiOperation =
  | 'explore'
  | 'podcast-search'
  | 'realtime-token'
  | 'transcribe'
  | 'speech'
  | 'voice-capabilities';

export type ApiErrorKind =
  | 'configuration'
  | 'invalid-request'
  | 'cancelled'
  | 'timeout'
  | 'network'
  | 'http'
  | 'invalid-response';

type ApiErrorDetails = {
  kind: ApiErrorKind;
  operation: ApiOperation;
  code: string;
  status?: number;
  retryable: boolean;
  fallbackEligible: boolean;
  cause?: unknown;
};

/** A caller-facing error that keeps remote failures distinguishable from cancellation. */
export class MurmurApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly operation: ApiOperation;
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly fallbackEligible: boolean;
  override readonly cause?: unknown;

  constructor(message: string, details: ApiErrorDetails) {
    super(message);
    this.name = 'MurmurApiError';
    this.kind = details.kind;
    this.operation = details.operation;
    this.code = details.code;
    this.status = details.status;
    this.retryable = details.retryable;
    this.fallbackEligible = details.fallbackEligible;
    this.cause = details.cause;
  }
}

export type ApiRuntime = {
  platform: 'web' | 'native';
  configuredBaseUrl?: string;
  development?: boolean;
  expoHostUri?: string;
};

type TimeoutConfig = Record<ApiOperation, number>;

export type MurmurApiClient = {
  createRealtimeSessionToken(
    surface: RealtimeVoiceSurface,
    options?: RequestControl,
  ): Promise<RealtimeSessionToken>;
  checkVoiceCapabilities(
    options?: RequestControl,
  ): Promise<VoiceCapabilitiesResult>;
  exploreTurn(
    payload: ExploreTurnPayload,
    options?: RequestControl,
  ): Promise<ExploreTurnResult>;
  searchPodcast(
    query: string,
    options?: RequestControl,
  ): Promise<PodcastSearchResult>;
  transcribeRecording(
    uri: string,
    metadata: RecordingMetadata,
    options?: RequestControl,
  ): Promise<TranscriptionResult>;
  synthesizeSpeech(
    text: string,
    options?: RequestControl,
  ): Promise<SynthesizedSpeech>;
};

type ClientDependencies = {
  fetch?: typeof globalThis.fetch;
  loadNativeRecordingFile?: (uri: string) => Promise<Blob>;
  runtime?: () => ApiRuntime;
  timeouts?: Partial<TimeoutConfig>;
};

const DEFAULT_TIMEOUTS: TimeoutConfig = {
  explore: 18_000,
  'podcast-search': 24_000,
  'realtime-token': 12_000,
  transcribe: 45_000,
  speech: 30_000,
  'voice-capabilities': 5_000,
};

const MURMUR_CLIENT_HEADERS = { 'X-Murmur-Client': 'expo' } as const;

function configurationError(message: string): MurmurApiError {
  return new MurmurApiError(message, {
    kind: 'configuration',
    operation: 'explore',
    code: 'api_not_configured',
    retryable: false,
    fallbackEligible: true,
  });
}

function stripTrailingSlash(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

function normalizeConfiguredBaseUrl(value: string, runtime: ApiRuntime): string {
  const candidate = value.trim();
  if (!candidate) throw configurationError('EXPO_PUBLIC_API_URL is empty.');

  if (candidate.startsWith('/')) {
    if (runtime.platform !== 'web' || candidate.startsWith('//')) {
      throw configurationError(
        'EXPO_PUBLIC_API_URL must be an absolute HTTP(S) URL on native.',
      );
    }

    const parsed = new URL(candidate, 'https://murmur.invalid');
    if (parsed.search || parsed.hash) {
      throw configurationError('EXPO_PUBLIC_API_URL cannot include a query or fragment.');
    }
    return stripTrailingSlash(parsed.pathname);
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (cause) {
    throw new MurmurApiError('EXPO_PUBLIC_API_URL is not a valid URL.', {
      kind: 'configuration',
      operation: 'explore',
      code: 'api_url_invalid',
      retryable: false,
      fallbackEligible: true,
      cause,
    });
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw configurationError('EXPO_PUBLIC_API_URL must use HTTP or HTTPS.');
  }
  if (
    runtime.platform === 'native' &&
    parsed.protocol !== 'https:' &&
    runtime.development !== true
  ) {
    throw configurationError('Production native API traffic must use HTTPS.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw configurationError(
      'EXPO_PUBLIC_API_URL cannot include credentials, a query, or a fragment.',
    );
  }

  return stripTrailingSlash(`${parsed.origin}${parsed.pathname}`);
}

function deriveNativeDevelopmentBaseUrl(hostUri: string): string {
  const candidate = hostUri.trim();
  if (!candidate) throw configurationError('Expo did not expose a development host.');
  const httpCandidate = candidate
    .replace(/^exp:\/\//i, 'http://')
    .replace(/^exps:\/\//i, 'https://');

  let parsed: URL;
  try {
    parsed = new URL(httpCandidate.includes('://') ? httpCandidate : `http://${httpCandidate}`);
  } catch (cause) {
    throw new MurmurApiError('Expo exposed an invalid development host.', {
      kind: 'configuration',
      operation: 'explore',
      code: 'expo_host_invalid',
      retryable: false,
      fallbackEligible: true,
      cause,
    });
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== '/' && parsed.pathname !== '' && !parsed.pathname.startsWith('/--')) ||
    parsed.search ||
    parsed.hash
  ) {
    throw configurationError('Expo did not expose a usable HTTP(S) development host.');
  }

  return `${parsed.origin}/api`;
}

/** Resolve the API root without ever treating a relative URL as valid on a device. */
export function resolveApiBaseUrl(runtime: ApiRuntime): string {
  // Expo Router API routes are served from the same origin as the web app.
  // Keep web traffic same-origin even when EXPO_PUBLIC_API_URL is set for an
  // Expo Go/device build; otherwise an HTTPS preview can accidentally make a
  // blocked mixed-content request to a LAN HTTP server.
  if (runtime.platform === 'web') return '/api';
  if (runtime.configuredBaseUrl?.trim()) {
    return normalizeConfiguredBaseUrl(runtime.configuredBaseUrl, runtime);
  }
  if (runtime.development && runtime.expoHostUri) {
    return deriveNativeDevelopmentBaseUrl(runtime.expoHostUri);
  }

  throw configurationError(
    'Set EXPO_PUBLIC_API_URL to the Murmur API root for native builds.',
  );
}

export type ExpoConstantsSubset = {
  debugMode?: boolean;
  expoConfig?: { hostUri?: string } | null;
  expoGoConfig?: { debuggerHost?: string } | null;
  experienceUrl?: string;
  linkingUri?: string;
};

/** Pick the most precise development-server address exposed by Expo Go. */
export function resolveExpoDevelopmentHostUri(
  constants: ExpoConstantsSubset | undefined,
): string | undefined {
  return [
    constants?.expoConfig?.hostUri,
    constants?.expoGoConfig?.debuggerHost,
    constants?.linkingUri,
    constants?.experienceUrl,
  ].find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0);
}

function defaultRuntime(): ApiRuntime {
  const configuredValue = process.env.EXPO_PUBLIC_API_URL;
  const configuredBaseUrl = configuredValue?.trim() ? configuredValue : undefined;
  const isWeb =
    process.env.EXPO_OS === 'web' ||
    (typeof document !== 'undefined' &&
      typeof window !== 'undefined' &&
      typeof window.location !== 'undefined');

  if (isWeb) return { platform: 'web', configuredBaseUrl };

  // Kept lazy so service-level Node tests do not initialize the native Expo runtime.
  // Metro still statically bundles this dependency because the module name is literal.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const constantsModule = require('expo-constants') as {
    default?: ExpoConstantsSubset;
  };
  const constants = constantsModule.default;
  const development =
    constants?.debugMode === true ||
    (typeof __DEV__ !== 'undefined' && __DEV__ === true);
  return {
    platform: 'native',
    configuredBaseUrl,
    development,
    expoHostUri: resolveExpoDevelopmentHostUri(constants),
  };
}

function endpointUrl(baseUrl: string, endpoint: string): string {
  return `${stripTrailingSlash(baseUrl)}/${endpoint}`;
}

function isAbortSignal(value: RequestControl | undefined): value is AbortSignal {
  return Boolean(
    value &&
      typeof (value as AbortSignal).aborted === 'boolean' &&
      typeof (value as AbortSignal).addEventListener === 'function',
  );
}

function requestOptions(control: RequestControl | undefined): RequestOptions {
  if (!control) return {};
  return isAbortSignal(control) ? { signal: control } : control;
}

function requirePositiveTimeout(timeoutMs: number, operation: ApiOperation): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new MurmurApiError('Request timeout must be a positive number.', {
      kind: 'invalid-request',
      operation,
      code: 'invalid_timeout',
      retryable: false,
      fallbackEligible: false,
    });
  }
  return timeoutMs;
}

function createRequestSignal(externalSignal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const cancelFromCaller = () => controller.abort(externalSignal?.reason);

  if (externalSignal?.aborted) cancelFromCaller();
  else externalSignal?.addEventListener('abort', cancelFromCaller, { once: true });

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', cancelFromCaller);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPodcastEpisode(value: unknown): value is PodcastEpisode {
  if (!isRecord(value) || !isRecord(value.audioAsset)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.guid === 'string' &&
    typeof value.podcastTitle === 'string' &&
    typeof value.title === 'string' &&
    typeof value.description === 'string' &&
    typeof value.audioAsset.url === 'string' &&
    value.audioAsset.url.startsWith('https://') &&
    typeof value.audioAsset.versionId === 'string' &&
    ['content-hash', 'feed-locator', 'publisher-version'].includes(
      String(value.audioAsset.identityKind),
    ) &&
    Array.isArray(value.transcriptSources) &&
    Array.isArray(value.adSegments)
  );
}

async function responseJson(
  response: Response,
  operation: ApiOperation,
): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    throw new MurmurApiError('The Murmur API returned unreadable JSON.', {
      kind: 'invalid-response',
      operation,
      code: 'invalid_json_response',
      status: response.status,
      retryable: true,
      fallbackEligible: true,
      cause,
    });
  }
}

async function throwForHttpError(response: Response, operation: ApiOperation): Promise<never> {
  let code = `http_${response.status}`;
  let message = `Murmur API request failed with HTTP ${response.status}.`;
  let retryable = response.status === 408 || response.status === 429 || response.status >= 500;

  try {
    const payload: unknown = await response.json();
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
    if (error) {
      if (typeof error.code === 'string' && error.code) code = error.code;
      if (typeof error.message === 'string' && error.message) message = error.message;
      if (typeof error.retryable === 'boolean') retryable = error.retryable;
    }
  } catch {
    // The stable HTTP fallback above is safer than surfacing an arbitrary HTML body.
  }

  throw new MurmurApiError(message, {
    kind: code === 'request_cancelled' ? 'cancelled' : code === 'provider_timeout' ? 'timeout' : 'http',
    operation,
    code,
    status: response.status,
    retryable,
    fallbackEligible:
      code !== 'request_cancelled' && (retryable || response.status === 408 || response.status === 429 || response.status >= 500),
  });
}

function classifyThrownError(
  error: unknown,
  operation: ApiOperation,
  externalSignal: AbortSignal | undefined,
  timedOut: boolean,
): MurmurApiError {
  if (error instanceof MurmurApiError) {
    if (error.kind !== 'configuration' || error.operation === operation) return error;
    return new MurmurApiError(error.message, {
      kind: error.kind,
      operation,
      code: error.code,
      status: error.status,
      retryable: error.retryable,
      fallbackEligible: error.fallbackEligible,
      cause: error.cause,
    });
  }
  if (timedOut) {
    return new MurmurApiError('The Murmur API took too long to respond.', {
      kind: 'timeout',
      operation,
      code: 'request_timeout',
      retryable: true,
      fallbackEligible: true,
      cause: error,
    });
  }
  if (externalSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return new MurmurApiError('The Murmur API request was cancelled.', {
      kind: 'cancelled',
      operation,
      code: 'request_cancelled',
      retryable: false,
      fallbackEligible: false,
      cause: error,
    });
  }
  return new MurmurApiError('The Murmur API could not be reached.', {
    kind: 'network',
    operation,
    code: 'network_unavailable',
    retryable: true,
    fallbackEligible: true,
    cause: error,
  });
}

function invalidRequest(operation: ApiOperation, message: string): MurmurApiError {
  return new MurmurApiError(message, {
    kind: 'invalid-request',
    operation,
    code: 'invalid_client_request',
    retryable: false,
    fallbackEligible: false,
  });
}

async function loadNativeRecordingFile(uri: string): Promise<Blob> {
  // Expo SDK 57 installs expo/fetch as the native global fetch. It serializes
  // expo-file-system File instances, but not React Native's legacy URI object.
  const { File } = await import('expo-file-system');
  const recording = new File(uri);
  if (!recording.exists || recording.size <= 0) {
    throw new Error('The device recording is missing or empty.');
  }
  return recording;
}

export function createMurmurApiClient(dependencies: ClientDependencies = {}): MurmurApiClient {
  const fetchImplementation = dependencies.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const nativeRecordingFileLoader =
    dependencies.loadNativeRecordingFile ?? loadNativeRecordingFile;
  const runtime = dependencies.runtime ?? defaultRuntime;
  const timeouts: TimeoutConfig = { ...DEFAULT_TIMEOUTS, ...dependencies.timeouts };

  async function perform<T>(
    operation: ApiOperation,
    control: RequestControl | undefined,
    task: (signal: AbortSignal, baseUrl: string, runtime: ApiRuntime) => Promise<T>,
  ): Promise<T> {
    const options = requestOptions(control);
    const timeoutMs = requirePositiveTimeout(options.timeoutMs ?? timeouts[operation], operation);
    const requestSignal = createRequestSignal(options.signal, timeoutMs);

    try {
      if (options.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const currentRuntime = runtime();
      return await task(
        requestSignal.signal,
        resolveApiBaseUrl(currentRuntime),
        currentRuntime,
      );
    } catch (error) {
      throw classifyThrownError(
        error,
        operation,
        options.signal,
        requestSignal.didTimeOut(),
      );
    } finally {
      requestSignal.cleanup();
    }
  }

  return {
    createRealtimeSessionToken(surface, control) {
      if (surface !== 'discovery' && surface !== 'episode') {
        return Promise.reject(
          invalidRequest('realtime-token', 'A valid realtime voice surface is required.'),
        );
      }

      return perform('realtime-token', control, async (signal, baseUrl) => {
        const response = await fetchImplementation(endpointUrl(baseUrl, 'realtime-token'), {
          method: 'POST',
          headers: {
            ...MURMUR_CLIENT_HEADERS,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ surface }),
          signal,
        });
        if (!response.ok) return throwForHttpError(response, 'realtime-token');

        const value = await responseJson(response, 'realtime-token');
        if (
          !isRecord(value) ||
          typeof value.clientSecret !== 'string' ||
          !value.clientSecret.startsWith('ek_') ||
          typeof value.expiresAt !== 'number' ||
          typeof value.model !== 'string' ||
          !value.model ||
          typeof value.sampleRate !== 'number' ||
          value.sampleRate <= 0
        ) {
          throw new MurmurApiError('The realtime voice session was incomplete.', {
            kind: 'invalid-response',
            operation: 'realtime-token',
            code: 'invalid_realtime_token_response',
            status: response.status,
            retryable: true,
            fallbackEligible: false,
          });
        }

        return {
          clientSecret: value.clientSecret,
          expiresAt: value.expiresAt,
          model: value.model,
          sampleRate: value.sampleRate,
        };
      });
    },

    checkVoiceCapabilities(control) {
      return perform('voice-capabilities', control, async (signal, baseUrl) => {
        const response = await fetchImplementation(
          endpointUrl(baseUrl, 'voice-capabilities'),
          {
            method: 'GET',
            headers: { ...MURMUR_CLIENT_HEADERS, Accept: 'application/json' },
            signal,
          },
        );
        if (!response.ok) {
          return throwForHttpError(response, 'voice-capabilities');
        }

        const value = await responseJson(response, 'voice-capabilities');
        if (
          !isRecord(value) ||
          (value.transcription !== 'ready' &&
            value.transcription !== 'unconfigured')
        ) {
          throw new MurmurApiError('The voice capabilities response was incomplete.', {
            kind: 'invalid-response',
            operation: 'voice-capabilities',
            code: 'invalid_voice_capabilities_response',
            status: response.status,
            retryable: true,
            fallbackEligible: true,
          });
        }

        return { transcription: value.transcription };
      });
    },

    exploreTurn(payload, control) {
      if (!payload.question.trim()) {
        return Promise.reject(invalidRequest('explore', 'An exploration question is required.'));
      }

      return perform('explore', control, async (signal, baseUrl) => {
        const response = await fetchImplementation(endpointUrl(baseUrl, 'explore'), {
          method: 'POST',
          headers: {
            ...MURMUR_CLIENT_HEADERS,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(payload),
          signal,
        });
        if (!response.ok) return throwForHttpError(response, 'explore');

        const value = await responseJson(response, 'explore');
        if (
          !isRecord(value) ||
          typeof value.answer !== 'string' ||
          !value.answer.trim() ||
          value.provider !== 'openai' ||
          typeof value.model !== 'string' ||
          !value.model
        ) {
          throw new MurmurApiError('The exploration response was incomplete.', {
            kind: 'invalid-response',
            operation: 'explore',
            code: 'invalid_explore_response',
            status: response.status,
            retryable: true,
            fallbackEligible: true,
          });
        }
        return {
          answer: value.answer.trim(),
          provider: value.provider,
          model: value.model,
        };
      });
    },

    searchPodcast(query, control) {
      const normalizedQuery = query.trim();
      if (!normalizedQuery || normalizedQuery.length > 240) {
        return Promise.reject(
          invalidRequest(
            'podcast-search',
            'Podcast search must be between 1 and 240 characters.',
          ),
        );
      }

      return perform('podcast-search', control, async (signal, baseUrl) => {
        const response = await fetchImplementation(endpointUrl(baseUrl, 'podcast-search'), {
          method: 'POST',
          headers: {
            ...MURMUR_CLIENT_HEADERS,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ query: normalizedQuery }),
          signal,
        });
        if (!response.ok) return throwForHttpError(response, 'podcast-search');

        const value = await responseJson(response, 'podcast-search');
        if (
          !isRecord(value) ||
          value.provider !== 'apple-podcasts-rss' ||
          !isRecord(value.query) ||
          typeof value.query.directory !== 'string' ||
          typeof value.query.wantsLatest !== 'boolean' ||
          !isRecord(value.podcast) ||
          typeof value.podcast.directoryId !== 'string' ||
          typeof value.podcast.title !== 'string' ||
          typeof value.podcast.feedUrl !== 'string' ||
          !isPodcastEpisode(value.episode)
        ) {
          throw new MurmurApiError('The podcast search response was incomplete.', {
            kind: 'invalid-response',
            operation: 'podcast-search',
            code: 'invalid_podcast_search_response',
            status: response.status,
            retryable: true,
            fallbackEligible: false,
          });
        }

        return value as PodcastSearchResult;
      });
    },

    transcribeRecording(uri, metadata, control) {
      if (!uri.trim()) {
        return Promise.reject(invalidRequest('transcribe', 'A recording URI is required.'));
      }
      if (!metadata.name.trim() || /[\r\n]/.test(metadata.name)) {
        return Promise.reject(invalidRequest('transcribe', 'A safe recording name is required.'));
      }
      if (!/^audio\/[a-z0-9.+-]+$/i.test(metadata.mimeType)) {
        return Promise.reject(invalidRequest('transcribe', 'A valid audio MIME type is required.'));
      }

      return perform('transcribe', control, async (signal, baseUrl, currentRuntime) => {
        const form = new FormData();

        if (currentRuntime.platform === 'web') {
          const recording = await fetchImplementation(uri, { signal });
          if (!recording.ok) {
            throw new MurmurApiError('The browser recording could not be read.', {
              kind: 'invalid-request',
              operation: 'transcribe',
              code: 'recording_unreadable',
              retryable: false,
              fallbackEligible: false,
              status: recording.status,
            });
          }
          const sourceBlob = await recording.blob();
          const recordingBlob =
            sourceBlob.type === metadata.mimeType
              ? sourceBlob
              : sourceBlob.slice(0, sourceBlob.size, metadata.mimeType);
          form.append('audio', recordingBlob, metadata.name);
        } else {
          let nativeFile: Blob;
          try {
            nativeFile = await nativeRecordingFileLoader(uri);
            if (nativeFile.size <= 0) {
              throw new Error('The device recording is empty.');
            }
          } catch (cause) {
            throw new MurmurApiError('The device recording could not be read.', {
              kind: 'invalid-request',
              operation: 'transcribe',
              code: 'recording_unreadable',
              retryable: false,
              fallbackEligible: false,
              cause,
            });
          }
          form.append(
            'audio',
            nativeFile.slice(0, nativeFile.size, metadata.mimeType),
            metadata.name,
          );
        }

        const response = await fetchImplementation(endpointUrl(baseUrl, 'transcribe'), {
          method: 'POST',
          headers: { ...MURMUR_CLIENT_HEADERS, Accept: 'application/json' },
          body: form,
          signal,
        });
        if (!response.ok) return throwForHttpError(response, 'transcribe');

        const value = await responseJson(response, 'transcribe');
        if (
          !isRecord(value) ||
          typeof value.transcript !== 'string' ||
          value.provider !== 'openai' ||
          typeof value.model !== 'string' ||
          !value.model
        ) {
          throw new MurmurApiError('The transcription response was incomplete.', {
            kind: 'invalid-response',
            operation: 'transcribe',
            code: 'invalid_transcription_response',
            status: response.status,
            retryable: true,
            fallbackEligible: true,
          });
        }
        return {
          transcript: value.transcript.trim(),
          provider: value.provider,
          model: value.model,
        };
      });
    },

    synthesizeSpeech(text, control) {
      if (!text.trim()) {
        return Promise.reject(invalidRequest('speech', 'Text is required for speech synthesis.'));
      }

      return perform('speech', control, async (signal, baseUrl) => {
        const response = await fetchImplementation(endpointUrl(baseUrl, 'speech'), {
          method: 'POST',
          headers: {
            ...MURMUR_CLIENT_HEADERS,
            'Content-Type': 'application/json',
            Accept: 'audio/mpeg',
          },
          body: JSON.stringify({ text }),
          signal,
        });
        if (!response.ok) return throwForHttpError(response, 'speech');

        const mimeType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
        if (!mimeType?.startsWith('audio/')) {
          throw new MurmurApiError('The speech response did not contain audio.', {
            kind: 'invalid-response',
            operation: 'speech',
            code: 'invalid_speech_content_type',
            status: response.status,
            retryable: true,
            fallbackEligible: true,
          });
        }

        if (response.headers.get('x-murmur-voice-disclosure') !== 'ai-generated') {
          throw new MurmurApiError('The speech response was missing its AI voice disclosure.', {
            kind: 'invalid-response',
            operation: 'speech',
            code: 'missing_voice_disclosure',
            status: response.status,
            retryable: false,
            fallbackEligible: true,
          });
        }

        const audio = await response.arrayBuffer();
        if (audio.byteLength === 0) {
          throw new MurmurApiError('The speech response contained no audio.', {
            kind: 'invalid-response',
            operation: 'speech',
            code: 'empty_speech_response',
            status: response.status,
            retryable: true,
            fallbackEligible: true,
          });
        }

        return {
          audio,
          mimeType,
          model: response.headers.get('x-murmur-model') ?? undefined,
          disclosure: 'ai-generated',
        };
      });
    },
  };
}

const defaultClient = createMurmurApiClient();

export const exploreTurn = defaultClient.exploreTurn;
export const searchPodcast = defaultClient.searchPodcast;
export const createRealtimeSessionToken = defaultClient.createRealtimeSessionToken;
export const transcribeRecording = defaultClient.transcribeRecording;
export const synthesizeSpeech = defaultClient.synthesizeSpeech;
export const checkVoiceCapabilities = defaultClient.checkVoiceCapabilities;
