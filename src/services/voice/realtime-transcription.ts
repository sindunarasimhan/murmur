import {
  createRealtimeSessionToken,
  MurmurApiError,
  type RealtimeSessionToken,
  type RealtimeVoiceSurface,
} from '@/services/api/murmur-api-client';

const REALTIME_URL = 'wss://api.openai.com/v1/realtime';
const SOCKET_OPEN = 1;
const CONNECT_TIMEOUT_MS = 12_000;
const CONNECT_ATTEMPTS = 2;
const CONNECT_RETRY_DELAY_MS = 350;
const FINAL_TRANSCRIPT_TIMEOUT_MS = 8_000;

type RealtimeServerEvent = {
  type?: unknown;
  delta?: unknown;
  transcript?: unknown;
  item_id?: unknown;
  error?: { message?: unknown; code?: unknown };
};

export type RealtimeTranscriptionCallbacks = {
  onConnected?: () => void;
  onSpeechStarted?: () => void;
  onSpeechStopped?: () => void;
  onPartialTranscript?: (transcript: string) => void;
  onFinalTranscript?: (transcript: string) => void;
  onError?: (error: Error) => void;
};

export type WebSocketLike = {
  readonly readyState: number;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

type WebSocketFactory = (
  url: string,
  protocols: readonly string[],
) => WebSocketLike;

export type RealtimeTranscriptionDependencies = {
  createToken?: (
    surface: RealtimeVoiceSurface,
    options?: { signal?: AbortSignal },
  ) => Promise<RealtimeSessionToken>;
  createWebSocket?: WebSocketFactory;
  connectAttempts?: number;
  connectTimeoutMs?: number;
  finalTranscriptTimeoutMs?: number;
  retryDelayMs?: number;
  wait?: (delayMs: number) => Promise<void>;
};

export class RealtimeVoiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RealtimeVoiceError';
    this.code = code;
  }
}

function defaultWebSocketFactory(
  url: string,
  protocols: readonly string[],
): WebSocketLike {
  return new WebSocket(url, [...protocols]) as unknown as WebSocketLike;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function retryableConnectionError(error: unknown): boolean {
  if (error instanceof MurmurApiError) return error.retryable;
  return (
    error instanceof RealtimeVoiceError &&
    ['connect_timeout', 'socket_error', 'socket_closed'].includes(error.code)
  );
}

export function bytesToBase64(bytes: Uint8Array): string {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const packed = (first << 16) | (second << 8) | third;

    output += alphabet[(packed >> 18) & 63];
    output += alphabet[(packed >> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(packed >> 6) & 63] : '=';
    output += index + 2 < bytes.length ? alphabet[packed & 63] : '=';
  }

  return output;
}

/** Downmixes interleaved signed 16-bit PCM and resamples it for Realtime. */
export function normalizePcm16(
  data: ArrayBuffer,
  sourceSampleRate: number,
  channels: number,
  targetSampleRate: number,
): Uint8Array {
  if (
    data.byteLength < 2 ||
    !Number.isFinite(sourceSampleRate) ||
    sourceSampleRate <= 0 ||
    !Number.isInteger(channels) ||
    channels <= 0 ||
    !Number.isFinite(targetSampleRate) ||
    targetSampleRate <= 0
  ) {
    return new Uint8Array();
  }

  const source = new Int16Array(data, 0, Math.floor(data.byteLength / 2));
  const sourceFrames = Math.floor(source.length / channels);
  if (sourceFrames === 0) return new Uint8Array();

  const mono = new Int16Array(sourceFrames);
  for (let frame = 0; frame < sourceFrames; frame += 1) {
    let sum = 0;
    const frameOffset = frame * channels;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += source[frameOffset + channel] ?? 0;
    }
    mono[frame] = Math.max(-32768, Math.min(32767, Math.round(sum / channels)));
  }

  if (sourceSampleRate === targetSampleRate) {
    return new Uint8Array(mono.buffer);
  }

  const targetFrames = Math.max(
    1,
    Math.round(sourceFrames * (targetSampleRate / sourceSampleRate)),
  );
  const output = new Int16Array(targetFrames);
  const sourcePerTarget = sourceSampleRate / targetSampleRate;

  for (let frame = 0; frame < targetFrames; frame += 1) {
    const sourcePosition = Math.min(sourceFrames - 1, frame * sourcePerTarget);
    const lower = Math.floor(sourcePosition);
    const upper = Math.min(sourceFrames - 1, lower + 1);
    const mix = sourcePosition - lower;
    output[frame] = Math.round(
      (mono[lower] ?? 0) * (1 - mix) + (mono[upper] ?? 0) * mix,
    );
  }

  return new Uint8Array(output.buffer);
}

export class RealtimeTranscriptionSession {
  private socket?: WebSocketLike;
  private targetSampleRate = 24_000;
  private transcript = '';
  private finalReceived = false;
  private closing = false;
  private connectAbort?: AbortController;
  private finishPromise?: Promise<string>;
  private resolveFinish?: (transcript: string) => void;
  private rejectFinish?: (error: Error) => void;

  constructor(
    private readonly callbacks: RealtimeTranscriptionCallbacks,
    private readonly dependencies: RealtimeTranscriptionDependencies = {},
  ) {}

  async connect(surface: RealtimeVoiceSurface): Promise<void> {
    if (this.socket) {
      throw new RealtimeVoiceError(
        'already_connected',
        'The realtime voice session is already connected.',
      );
    }

    const attempts = Math.max(
      1,
      Math.floor(this.dependencies.connectAttempts ?? CONNECT_ATTEMPTS),
    );
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.connectOnce(surface);
        return;
      } catch (error) {
        lastError = error instanceof Error
          ? error
          : new RealtimeVoiceError('connect_failed', 'Live voice could not connect.');
        this.discardConnectionAttempt();

        if (
          this.closing ||
          attempt === attempts - 1 ||
          !retryableConnectionError(lastError)
        ) {
          throw lastError;
        }

        await (this.dependencies.wait ?? wait)(
          this.dependencies.retryDelayMs ?? CONNECT_RETRY_DELAY_MS,
        );
      }
    }

    throw lastError ?? new RealtimeVoiceError(
      'connect_failed',
      'Live voice could not connect.',
    );
  }

  private async connectOnce(surface: RealtimeVoiceSurface): Promise<void> {
    this.connectAbort = new AbortController();
    let token: RealtimeSessionToken;
    try {
      token = await (this.dependencies.createToken ?? createRealtimeSessionToken)(
        surface,
        { signal: this.connectAbort.signal },
      );
    } finally {
      this.connectAbort = undefined;
    }
    if (this.closing) {
      throw new RealtimeVoiceError('cancelled', 'The realtime voice session was cancelled.');
    }
    this.targetSampleRate = token.sampleRate;

    const socket = (this.dependencies.createWebSocket ?? defaultWebSocketFactory)(
      REALTIME_URL,
      ['realtime', `openai-insecure-api-key.${token.clientSecret}`],
    );
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new RealtimeVoiceError(
            'connect_timeout',
            'The realtime voice service took too long to connect.',
          ),
        );
      }, this.dependencies.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.callbacks.onConnected?.();
        resolve();
      };
      socket.onmessage = (event) => this.handleMessage(event.data);
      socket.onerror = () => {
        const error = new RealtimeVoiceError(
          'socket_error',
          'The realtime voice connection failed.',
        );
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        } else {
          this.fail(error);
        }
      };
      socket.onclose = (event) => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(
            new RealtimeVoiceError(
              'socket_closed',
              'The realtime voice connection closed before it was ready.',
            ),
          );
          return;
        }
        if (!this.closing && !this.finalReceived) {
          this.fail(
            new RealtimeVoiceError(
              'socket_closed',
              event.reason || 'The realtime voice connection ended unexpectedly.',
            ),
          );
        }
      };
    });
  }

  private discardConnectionAttempt(): void {
    this.connectAbort?.abort();
    this.connectAbort = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;

    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.close(1000, 'retrying connection');
  }

  appendPcm(data: ArrayBuffer, sampleRate: number, channels = 1): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN || this.closing) return;

    const pcm = normalizePcm16(
      data,
      sampleRate,
      channels,
      this.targetSampleRate,
    );
    if (pcm.byteLength === 0) return;

    socket.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: bytesToBase64(pcm),
      }),
    );
  }

  /**
   * Discards audio and partial text that have not been committed yet.
   * Wake-word monitoring uses this to keep a short rolling window instead of
   * retaining an entire playback session in one transcription buffer.
   */
  clearInputBuffer(): void {
    const socket = this.socket;
    if (
      !socket ||
      socket.readyState !== SOCKET_OPEN ||
      this.closing ||
      this.finishPromise ||
      this.finalReceived
    ) {
      return;
    }

    this.transcript = '';
    socket.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
  }

  finish(): Promise<string> {
    if (this.finalReceived) return Promise.resolve(this.transcript.trim());
    if (this.finishPromise) return this.finishPromise;

    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      return Promise.reject(
        new RealtimeVoiceError(
          'not_connected',
          'The realtime voice connection is not open.',
        ),
      );
    }

    socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    this.finishPromise = new Promise<string>((resolve, reject) => {
      this.resolveFinish = resolve;
      this.rejectFinish = reject;
      setTimeout(() => {
        if (this.finalReceived || this.closing) return;
        this.fail(
          new RealtimeVoiceError(
            'transcript_timeout',
            'Murmur did not receive a final transcript in time.',
          ),
        );
      }, this.dependencies.finalTranscriptTimeoutMs ?? FINAL_TRANSCRIPT_TIMEOUT_MS);
    });
    return this.finishPromise;
  }

  cancel(): void {
    if (this.closing) return;
    this.closing = true;
    this.connectAbort?.abort();
    this.connectAbort = undefined;
    this.socket?.close(1000, 'client closed');
    this.socket = undefined;
    this.rejectFinish?.(
      new RealtimeVoiceError('cancelled', 'The realtime voice session was cancelled.'),
    );
    this.resolveFinish = undefined;
    this.rejectFinish = undefined;
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;

    let event: RealtimeServerEvent;
    try {
      event = JSON.parse(raw) as RealtimeServerEvent;
    } catch {
      return;
    }

    if (event.type === 'input_audio_buffer.speech_started') {
      this.callbacks.onSpeechStarted?.();
      return;
    }
    if (event.type === 'input_audio_buffer.speech_stopped') {
      this.callbacks.onSpeechStopped?.();
      return;
    }
    if (
      event.type === 'conversation.item.input_audio_transcription.delta' &&
      typeof event.delta === 'string'
    ) {
      this.transcript += event.delta;
      this.callbacks.onPartialTranscript?.(this.transcript.trimStart());
      return;
    }
    if (
      event.type === 'conversation.item.input_audio_transcription.completed' &&
      typeof event.transcript === 'string'
    ) {
      const transcript = event.transcript.trim() || this.transcript.trim();
      this.transcript = transcript;
      this.finalReceived = true;
      this.callbacks.onFinalTranscript?.(transcript);
      this.resolveFinish?.(transcript);
      this.resolveFinish = undefined;
      this.rejectFinish = undefined;
      return;
    }
    if (event.type === 'error') {
      const message =
        typeof event.error?.message === 'string'
          ? event.error.message
          : 'The realtime voice service returned an error.';
      const code =
        typeof event.error?.code === 'string' ? event.error.code : 'server_error';
      this.fail(new RealtimeVoiceError(code, message));
    }
  }

  private fail(error: Error): void {
    if (this.closing) return;
    this.callbacks.onError?.(error);
    this.rejectFinish?.(error);
    this.rejectFinish = undefined;
    this.resolveFinish = undefined;
    this.closing = true;
    // Browser clients may send 1000 or an application code in 3000–4999.
    this.socket?.close(4000, 'realtime error');
    this.socket = undefined;
  }
}
