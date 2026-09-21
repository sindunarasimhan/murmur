export type WebPcmCapture = {
  stop(): Promise<void>;
};

export type WebPcmChunk = {
  data: ArrayBuffer;
  sampleRate: number;
  channels: 1;
};

export type WebPcmCaptureAvailability =
  | { available: true }
  | {
      available: false;
      reason: 'insecure-context' | 'microphone-unavailable' | 'audio-context-unavailable';
    };

export type WebPcmCaptureErrorCode =
  | Exclude<WebPcmCaptureAvailability, { available: true }>['reason']
  | 'microphone-denied'
  | 'microphone-busy'
  | 'microphone-failed';

export class WebPcmCaptureError extends Error {
  readonly code: WebPcmCaptureErrorCode;

  constructor(
    code: WebPcmCaptureErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WebPcmCaptureError';
    this.code = code;
  }
}

const MICROPHONE_RETRY_DELAY_MS = 350;

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** Preserve browser microphone failures as stable, user-actionable codes. */
export function normalizeWebPcmCaptureError(error: unknown): WebPcmCaptureError {
  if (error instanceof WebPcmCaptureError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new WebPcmCaptureError(
      'microphone-denied',
      'Microphone permission was denied.',
    );
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return new WebPcmCaptureError(
      'microphone-busy',
      'The browser could not open the microphone yet.',
    );
  }
  return new WebPcmCaptureError(
    'microphone-failed',
    'The browser could not start microphone capture.',
  );
}

type WebPcmEnvironment = {
  protocol: string;
  hostname: string;
  hasGetUserMedia: boolean;
  hasAudioContext: boolean;
};

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function resolveWebPcmCaptureAvailability(
  environment: WebPcmEnvironment,
): WebPcmCaptureAvailability {
  if (
    environment.protocol !== 'https:' &&
    !isLoopbackHostname(environment.hostname)
  ) {
    return { available: false, reason: 'insecure-context' };
  }
  if (!environment.hasGetUserMedia) {
    return { available: false, reason: 'microphone-unavailable' };
  }
  if (!environment.hasAudioContext) {
    return { available: false, reason: 'audio-context-unavailable' };
  }
  return { available: true };
}

export function assertWebPcmCaptureAvailable(): void {
  if (process.env.EXPO_OS !== 'web') return;

  const availability = resolveWebPcmCaptureAvailability({
    protocol: typeof location === 'undefined' ? '' : location.protocol,
    hostname: typeof location === 'undefined' ? '' : location.hostname,
    hasGetUserMedia: Boolean(
      typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia,
    ),
    hasAudioContext: typeof AudioContext !== 'undefined',
  });
  if (availability.available) return;

  if (availability.reason === 'insecure-context') {
    throw new WebPcmCaptureError(
      availability.reason,
      'Browser microphone capture requires HTTPS or localhost.',
    );
  }
  if (availability.reason === 'audio-context-unavailable') {
    throw new WebPcmCaptureError(
      availability.reason,
      'This browser does not expose live audio processing.',
    );
  }
  throw new WebPcmCaptureError(
    availability.reason,
    'This preview does not expose a microphone.',
  );
}

export function float32ToPcm16(samples: Float32Array): ArrayBuffer {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    pcm[index] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
  }
  return pcm.buffer;
}

export async function startWebPcmCapture(
  onChunk: (chunk: WebPcmChunk) => void,
): Promise<WebPcmCapture> {
  assertWebPcmCaptureAvailable();

  const constraints: MediaStreamConstraints = {
    audio: {
      autoGainControl: true,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  };
  let mediaStream: MediaStream;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (error) {
    const normalized = normalizeWebPcmCaptureError(error);
    if (normalized.code !== 'microphone-busy') throw normalized;

    await delay(MICROPHONE_RETRY_DELAY_MS);
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (retryError) {
      throw normalizeWebPcmCaptureError(retryError);
    }
  }
  const context = new AudioContext();
  await context.resume();
  const source = context.createMediaStreamSource(mediaStream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const silentOutput = context.createGain();
  silentOutput.gain.value = 0;

  processor.onaudioprocess = (event) => {
    const samples = event.inputBuffer.getChannelData(0);
    onChunk({
      data: float32ToPcm16(samples),
      sampleRate: context.sampleRate,
      channels: 1,
    });
  };

  source.connect(processor);
  processor.connect(silentOutput);
  silentOutput.connect(context.destination);

  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      processor.onaudioprocess = null;
      source.disconnect();
      processor.disconnect();
      silentOutput.disconnect();
      for (const track of mediaStream.getTracks()) track.stop();
      await context.close().catch(() => undefined);
    },
  };
}
