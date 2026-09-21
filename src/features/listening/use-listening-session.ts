import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioStream,
  useAudioPlayer,
  useAudioPlayerStatus,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { Directory, File, Paths } from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState } from 'react';

import { resolveDiscoveryVoiceSelection } from '@/domain/discovery-voice-resolver';
import { decorateRemoteEpisode } from '@/data/catalog-repository';
import type { CatalogEpisode, TranscriptCue } from '@/domain/podcast';
import {
  type InquiryCategory,
  resolveVerifiedAdSegment,
  routeVoiceIntent,
} from '@/domain/voice-intent';
import type {
  ListeningMode,
  TranscriptStatus,
} from '@/features/listening/player-stage';
import { formatDuration } from '@/features/listening/format';
import {
  PLAYBACK_AUDIO_MODE,
  RECORDING_AUDIO_MODE,
} from '@/features/listening/audio-mode';
import { useAssistantVoice } from '@/features/listening/use-assistant-voice';
import { resolveWebVoiceCaptureStrategy } from '@/features/listening/web-voice-capture';
import {
  checkVoiceCapabilities,
  exploreTurn,
  MurmurApiError,
  searchPodcast,
  transcribeRecording,
} from '@/services/api/murmur-api-client';
import { buildContextualAnswer } from '@/services/exploration/build-contextual-answer';
import {
  buildEpisodeMetadataContext,
  buildTranscriptContext,
} from '@/services/exploration/build-transcript-context';
import { fetchEpisodeTranscript } from '@/services/rss/fetch-podcast-feed';
import {
  RealtimeTranscriptionSession,
  RealtimeVoiceError,
} from '@/services/voice/realtime-transcription';
import {
  assertWebPcmCaptureAvailable,
  startWebPcmCapture,
  WebPcmCaptureError,
  type WebPcmCapture,
} from '@/services/voice/web-pcm-capture';
import {
  matchMurmurWakeWord,
  type WakeWordStatus,
} from '@/services/voice/wake-word';

type BrowserSpeechResult = {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
};

type BrowserSpeechEvent = {
  readonly resultIndex: number;
  readonly results: ArrayLike<BrowserSpeechResult>;
};

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: BrowserSpeechEvent) => void) | null;
  onerror: ((event: BrowserSpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type BrowserSpeechErrorEvent = {
  readonly error?: string;
};

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

type BrowserTranscriptionCallbacks = {
  onTranscript?: (transcript: string) => void;
  onError?: (reason?: string) => void;
  onEnd?: () => void;
};

type SpeechCapableGlobal = typeof globalThis & {
  SpeechRecognition?: BrowserSpeechRecognitionConstructor;
  webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
};

const playbackRates = [1, 1.25, 1.5, 1.75, 2] as const;
const RECORDING_METERING_FLOOR_DB = -60;
const NATIVE_SPEECH_THRESHOLD_DB = -45;
const NATIVE_SILENCE_THRESHOLD_DB = -52;
const NATIVE_SILENCE_MIN_RECORDING_MS = 700;
const NATIVE_SILENCE_TIMEOUT_MS = 2_200;
const NATIVE_RECORDING_AUTO_FINALIZE_MS = 12_000;
const NATIVE_PCM_SPEECH_RMS = 0.008;
const NATIVE_PCM_SILENCE_RMS = 0.0045;
const NATIVE_PCM_SILENCE_TIMEOUT_MS = 1_150;
const NATIVE_PCM_METER_THROTTLE_MS = 90;
const WAKE_WORD_BUFFER_RESET_MS = 12_000;

type TranscriptionReadiness = 'ready' | 'unconfigured' | 'unreachable';

type NativePcmChunk = {
  channels: number;
  data: Uint8Array<ArrayBuffer>;
  sampleRate: number;
};

export type ExplorationTurn = {
  id: string;
  question: string;
  answer: string;
  category: InquiryCategory;
};

export type DiscoveryVoiceState = {
  errorKind?: 'podcast-search' | 'voice';
  phase: 'idle' | 'arming' | 'listening' | 'processing' | 'error';
  transcript: string;
  message?: string;
};

export type PlaybackIssue = 'error' | 'ended';

export type WakeWordActivation = {
  id: number;
  playbackPositionSeconds: number;
};

const IDLE_DISCOVERY_VOICE: DiscoveryVoiceState = {
  phase: 'idle',
  transcript: '',
};

function clampPosition(seconds: number, duration: number): number {
  const upperBound = Number.isFinite(duration) && duration > 0 ? duration : Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.min(seconds, upperBound));
}

function normalizeRecordingMetering(
  metering: number | undefined,
  isRecording: boolean,
): number | null {
  if (!isRecording || typeof metering !== 'number' || !Number.isFinite(metering)) {
    return null;
  }

  return Math.max(
    0,
    Math.min(1, (metering - RECORDING_METERING_FLOOR_DB) / -RECORDING_METERING_FLOOR_DB),
  );
}

function recordingMetadata(uri: string): { mimeType: string; name: string } {
  if (process.env.EXPO_OS === 'web' && uri.startsWith('blob:')) {
    const recordsWebM =
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm');
    return recordsWebM
      ? { mimeType: 'audio/webm', name: 'murmur-question.webm' }
      : { mimeType: 'audio/mp4', name: 'murmur-question.m4a' };
  }
  const extension = uri.match(/\.([a-z0-9]+)(?:[?#]|$)/i)?.[1]?.toLowerCase();
  if (extension === 'wav') return { mimeType: 'audio/wav', name: 'murmur-question.wav' };
  if (extension === 'webm') return { mimeType: 'audio/webm', name: 'murmur-question.webm' };
  if (extension === 'mp3') return { mimeType: 'audio/mpeg', name: 'murmur-question.mp3' };
  return { mimeType: 'audio/mp4', name: 'murmur-question.m4a' };
}

function nativePcmRms(data: ArrayBuffer): number {
  const samples = new Int16Array(data);
  if (samples.length === 0) return 0;

  let sumSquares = 0;
  const stride = Math.max(1, Math.floor(samples.length / 1_600));
  let count = 0;
  for (let index = 0; index < samples.length; index += stride) {
    const normalized = (samples[index] ?? 0) / 32768;
    sumSquares += normalized * normalized;
    count += 1;
  }

  return count > 0 ? Math.sqrt(sumSquares / count) : 0;
}

function nativePcmMeterLevel(data: ArrayBuffer): number {
  return clampPosition(nativePcmRms(data) * 14, 1);
}

function wavFromInt16Chunks(chunks: readonly NativePcmChunk[]): Uint8Array<ArrayBuffer> {
  const firstChunk = chunks[0];
  if (!firstChunk) return new Uint8Array();

  const sampleRate = firstChunk.sampleRate;
  const channels = firstChunk.channels;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataBytes = chunks.reduce((total, chunk) => total + chunk.data.byteLength, 0);
  const wavBytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(wavBytes.buffer);
  let offset = 0;

  const writeAscii = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
    offset += value.length;
  };

  writeAscii('RIFF');
  view.setUint32(offset, 36 + dataBytes, true);
  offset += 4;
  writeAscii('WAVE');
  writeAscii('fmt ');
  view.setUint32(offset, 16, true);
  offset += 4;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint16(offset, channels, true);
  offset += 2;
  view.setUint32(offset, sampleRate, true);
  offset += 4;
  view.setUint32(offset, sampleRate * channels * bytesPerSample, true);
  offset += 4;
  view.setUint16(offset, channels * bytesPerSample, true);
  offset += 2;
  view.setUint16(offset, bitsPerSample, true);
  offset += 2;
  writeAscii('data');
  view.setUint32(offset, dataBytes, true);
  offset += 4;

  for (const chunk of chunks) {
    wavBytes.set(chunk.data, offset);
    offset += chunk.data.byteLength;
  }

  return wavBytes;
}

function writeNativePcmRecording(chunks: readonly NativePcmChunk[]): string | undefined {
  if (chunks.length === 0 || process.env.EXPO_OS === 'web') return undefined;

  const wavBytes = wavFromInt16Chunks(chunks);
  if (wavBytes.byteLength <= 44) return undefined;

  const destination = new File(
    Paths.cache,
    `murmur-question-${Date.now()}-${Math.random().toString(36).slice(2, 9)}.wav`,
  );

  try {
    destination.write(wavBytes);
    if (!destination.exists || destination.size <= 44) {
      deleteNativeRecording(destination.uri);
      return undefined;
    }
    return destination.uri;
  } catch {
    deleteNativeRecording(destination.uri);
    return undefined;
  }
}

function deleteNativeRecording(uri: string | undefined): void {
  if (!uri || process.env.EXPO_OS === 'web') return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Recording cleanup is best-effort and must not interrupt a listening handoff.
  }
}

function revokeBrowserRecording(uri: string | undefined): void {
  if (!uri || process.env.EXPO_OS !== 'web' || !uri.startsWith('blob:')) return;
  try {
    globalThis.URL.revokeObjectURL(uri);
  } catch {
    // Browser blob cleanup is best-effort and must not interrupt a listening handoff.
  }
}

function deleteVoiceRecording(uri: string | undefined): void {
  if (process.env.EXPO_OS === 'web') {
    revokeBrowserRecording(uri);
  } else {
    deleteNativeRecording(uri);
  }
}

function waitForTranscriptReveal(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 700);
  });
}

function voiceDebug(event: string, details?: Record<string, unknown>): void {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.info(`[murmur voice] ${event}`, details ?? {});
  }
}

function transcriptionFailureMessage(error: unknown): string {
  if (error instanceof MurmurApiError) {
    if (error.code === 'openai_not_configured') {
      return 'Voice transcription is not connected on this server yet. Connect it, then try voice again.';
    }
    if (error.kind === 'configuration' || error.code === 'api_not_configured') {
      return 'This build is not connected to the Murmur voice server. Check the connection, then try again.';
    }
    if (error.kind === 'network' || error.code === 'network_unavailable') {
      return 'The Murmur voice server could not be reached. Check the connection, then try again.';
    }
  }

  return 'Voice was recorded, but transcription could not finish. Your place is safe; try voice again.';
}

function realtimeVoiceFailureMessage(error: unknown, episodeActive = false): string {
  const safePlace = episodeActive ? ' Your place is safe.' : '';
  if (error instanceof WebPcmCaptureError && error.code === 'insecure-context') {
    return 'Browser voice needs HTTPS or localhost. Use Expo Go on iPhone, or open the localhost preview on this Mac.';
  }
  if (error instanceof WebPcmCaptureError && error.code === 'microphone-denied') {
    return `Microphone access is off.${safePlace} Allow it in browser settings, then try again.`;
  }
  if (error instanceof WebPcmCaptureError && error.code === 'microphone-busy') {
    return `The microphone is busy in another tab or app.${safePlace} Close the other recording session, then try again.`;
  }
  if (error instanceof WebPcmCaptureError && error.code === 'microphone-failed') {
    return `The browser could not open the microphone.${safePlace} Try again.`;
  }
  if (error instanceof WebPcmCaptureError) {
    return 'This embedded preview does not expose a microphone. Use Expo Go on iPhone, or open Murmur in Chrome or Safari.';
  }
  if (error instanceof RealtimeVoiceError && error.code === 'microphone_denied') {
    return `Microphone access is off.${safePlace}`;
  }
  if (
    error instanceof MurmurApiError &&
    error.code === 'openai_not_configured'
  ) {
    return 'Live voice isn’t configured on this Murmur server yet.';
  }
  if (error instanceof MurmurApiError && error.kind === 'configuration') {
    return 'Murmur cannot connect with this server address. Reload the app from your current Expo Go link.';
  }
  if (
    error instanceof MurmurApiError &&
    (error.kind === 'network' || error.code === 'network_unavailable')
  ) {
    return `The Murmur server could not be reached.${safePlace}`;
  }
  return `Live voice could not connect.${safePlace} Check the connection and try again.`;
}

function podcastSearchFailureMessage(error: unknown): string {
  if (error instanceof MurmurApiError) {
    if (error.code === 'podcast_not_found') {
      return 'I couldn’t find that podcast. Try saying the exact show title.';
    }
    if (error.code === 'public_feed_unavailable') {
      return 'I couldn’t find a verified public RSS feed for that podcast. Try another show.';
    }
    if (error.code === 'episode_not_found') {
      return 'I found the podcast, but its feed has no playable episodes.';
    }
    if (error.code === 'feed_unavailable') {
      return 'I found the podcast, but its RSS feed is unavailable right now.';
    }
  }
  return 'Podcast search is unavailable right now. Try again.';
}

function browserSpeechFailureMessage(reason?: string): string {
  if (reason === 'not-allowed' || reason === 'service-not-allowed') {
    return 'Microphone access is off for this browser. Allow it in browser settings, then try again.';
  }
  if (reason === 'audio-capture') {
    return 'This browser could not access a microphone. Check the input device, then try again.';
  }
  if (reason === 'network') {
    return 'This browser’s live voice service could not connect. Try voice again in Chrome or Safari.';
  }
  if (reason === 'no-speech') {
    return 'I didn’t hear speech. Try voice again.';
  }
  return 'Live voice stopped in this browser. Try voice again.';
}

function webVoiceCaptureCapabilities(): {
  liveTranscription: boolean;
  recordingUpload: boolean;
} {
  if (process.env.EXPO_OS !== 'web') {
    return { liveTranscription: false, recordingUpload: false };
  }
  const speechGlobal = globalThis as SpeechCapableGlobal;
  const browserNavigator = typeof navigator === 'undefined' ? undefined : navigator;
  return {
    liveTranscription: Boolean(
      speechGlobal.SpeechRecognition ?? speechGlobal.webkitSpeechRecognition,
    ),
    recordingUpload: Boolean(
      typeof MediaRecorder !== 'undefined' &&
      browserNavigator?.mediaDevices?.getUserMedia,
    ),
  };
}

function deleteStaleVoiceCacheFiles(): void {
  if (process.env.EXPO_OS === 'web') return;

  try {
    const ownedLocations = [
      {
        directory: Paths.cache,
        fileName: /^murmur-(?:question|assistant)-/,
      },
      {
        directory: new Directory(Paths.cache, 'ExpoAudio'),
        fileName: /^recording-[a-f0-9-]+\.[a-z0-9]+$/i,
      },
      {
        directory: new Directory(Paths.cache, 'Audio'),
        fileName: /^recording-[a-f0-9-]+\.[a-z0-9]+$/i,
      },
    ];

    for (const { directory, fileName } of ownedLocations) {
      if (!directory.exists) continue;
      for (const entry of directory.list()) {
        if (entry instanceof File && fileName.test(entry.name)) {
          entry.delete();
        }
      }
    }
  } catch {
    // Startup privacy cleanup is best-effort; the OS also owns cache eviction.
  }
}

async function preserveNativeRecordingForUpload(
  uri: string | undefined,
): Promise<string | undefined> {
  if (!uri || process.env.EXPO_OS === 'web') return undefined;

  const source = new File(uri);
  const extension = source.extension || '.m4a';
  const destination = new File(
    Paths.cache,
    `murmur-question-${Date.now()}-${Math.random().toString(36).slice(2, 9)}${extension}`,
  );

  try {
    if (!source.exists) return undefined;
    await source.copy(destination);
    return destination.uri;
  } catch {
    deleteNativeRecording(destination.uri);
    return undefined;
  } finally {
    deleteNativeRecording(uri);
  }
}

export function useListeningSession() {
  const player = useAudioPlayer(null, {
    updateInterval: 250,
    crossOrigin: 'anonymous',
    preferredForwardBufferDuration: 12,
  });
  const playerStatus = useAudioPlayerStatus(player);
  const recorder = useAudioRecorder({
    ...RecordingPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });
  const recorderState = useAudioRecorderState(recorder, 160);
  const { speak: speakAssistant, stop: stopAssistant } = useAssistantVoice();

  const [episode, setEpisode] = useState<CatalogEpisode>();
  const [started, setStarted] = useState(false);
  const [mode, setMode] = useState<ListeningMode>('idle');
  const [transcript, setTranscript] = useState<TranscriptCue[]>([]);
  const [transcriptStatus, setTranscriptStatus] = useState<TranscriptStatus>('loading');
  const [transcriptText, setTranscriptText] = useState('');
  const [response, setResponse] = useState<string>();
  const [responseCategory, setResponseCategory] = useState<InquiryCategory>();
  const [responseProvider, setResponseProvider] = useState<'local' | 'openai'>();
  const [activityMessage, setActivityMessage] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [playbackIssue, setPlaybackIssue] = useState<PlaybackIssue>();
  const [turns, setTurns] = useState<ExplorationTurn[]>([]);
  const [discoveryVoice, setDiscoveryVoice] = useState<DiscoveryVoiceState>(
    IDLE_DISCOVERY_VOICE,
  );
  const [nativePcmDurationMillis, setNativePcmDurationMillis] = useState(0);
  const [nativePcmMetering, setNativePcmMetering] = useState<number | null>(null);
  const [wakeWordStatus, setWakeWordStatus] = useState<WakeWordStatus>('inactive');
  const [wakeWordActivation, setWakeWordActivation] = useState<WakeWordActivation>();

  const episodeRef = useRef<CatalogEpisode | undefined>(undefined);
  const transcriptRef = useRef<TranscriptCue[]>([]);
  const transcriptRequestRef = useRef(0);
  const returnAnchorRef = useRef(0);
  const resumeAfterVoiceRef = useRef(false);
  const recognitionRef = useRef<BrowserSpeechRecognition | undefined>(undefined);
  const browserRecognitionUnavailableRef = useRef(false);
  const transcriptionReadinessRef = useRef<'unknown' | 'ready' | 'unconfigured'>('unknown');
  const browserTranscriptRef = useRef('');
  const mountedRef = useRef(true);
  const recordingActiveRef = useRef(false);
  const nativeRecorderPreparedRef = useRef(false);
  const recordingUriRef = useRef<string | undefined>(undefined);
  const episodeVoiceActiveRef = useRef(false);
  const voiceSessionPreparedRef = useRef(false);
  const recordingBeganAtRef = useRef(0);
  const recordingLimitTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const nativeSpeechDetectedRef = useRef(false);
  const nativeSilenceBeganAtRef = useRef<number | undefined>(undefined);
  const nativeSilenceFinalizeRequestedRef = useRef(false);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const operationRef = useRef(0);
  const voiceStartOperationRef = useRef<number | undefined>(undefined);
  const voiceStopInFlightRef = useRef(false);
  const voiceStopCompletionRef = useRef<Promise<void>>(Promise.resolve());
  const resolveVoiceStopRef = useRef<(() => void) | undefined>(undefined);
  const requestAbortRef = useRef<AbortController | undefined>(undefined);
  const submitIntentRef = useRef<((utterance: string) => Promise<void>) | undefined>(undefined);
  const beginVoiceRef = useRef<(() => Promise<void>) | undefined>(undefined);
  const recordingFinalizeRef = useRef<(() => void) | undefined>(undefined);
  const discoveryVoiceRef = useRef<DiscoveryVoiceState>(IDLE_DISCOVERY_VOICE);
  const discoveryEpisodesRef = useRef<readonly CatalogEpisode[]>([]);
  const discoveryFocusedEpisodeIdRef = useRef<string | undefined>(undefined);
  const discoveryFinalizeRef = useRef<(() => Promise<void>) | undefined>(undefined);
  const discoveryFinalizingRef = useRef(false);
  const nativePcmRecordingRef = useRef(false);
  const nativePcmChunksRef = useRef<NativePcmChunk[]>([]);
  const nativePcmLastMeterAtRef = useRef(0);
  const realtimeSessionRef = useRef<RealtimeTranscriptionSession | undefined>(undefined);
  const realtimeNativeCaptureRef = useRef(false);
  const realtimeWebCaptureRef = useRef<WebPcmCapture | undefined>(undefined);
  const wakeWordSessionRef = useRef<RealtimeTranscriptionSession | undefined>(undefined);
  const wakeWordNativeCaptureRef = useRef(false);
  const wakeWordWebCaptureRef = useRef<WebPcmCapture | undefined>(undefined);
  const wakeWordGenerationRef = useRef(0);
  const wakeWordActivationIdRef = useRef(0);
  const wakeWordBufferTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const handleNativePcmBuffer = useCallback((buffer: {
    data: ArrayBuffer;
    sampleRate: number;
    channels: number;
    timestamp: number;
  }) => {
    if (wakeWordNativeCaptureRef.current && process.env.EXPO_OS !== 'web') {
      wakeWordSessionRef.current?.appendPcm(
        buffer.data,
        buffer.sampleRate,
        buffer.channels,
      );
      return;
    }

    if (realtimeNativeCaptureRef.current && process.env.EXPO_OS !== 'web') {
      realtimeSessionRef.current?.appendPcm(
        buffer.data,
        buffer.sampleRate,
        buffer.channels,
      );
      const now = Date.now();
      if (now - nativePcmLastMeterAtRef.current >= NATIVE_PCM_METER_THROTTLE_MS) {
        nativePcmLastMeterAtRef.current = now;
        setNativePcmDurationMillis(Math.round(buffer.timestamp * 1_000));
        setNativePcmMetering(nativePcmMeterLevel(buffer.data));
      }

      const rms = nativePcmRms(buffer.data);
      const recordingDurationMillis = recordingBeganAtRef.current > 0
        ? now - recordingBeganAtRef.current
        : 0;
      if (rms >= NATIVE_PCM_SPEECH_RMS) {
        nativeSpeechDetectedRef.current = true;
        nativeSilenceBeganAtRef.current = undefined;
      } else if (
        nativeSpeechDetectedRef.current &&
        recordingDurationMillis >= NATIVE_SILENCE_MIN_RECORDING_MS &&
        rms <= NATIVE_PCM_SILENCE_RMS
      ) {
        nativeSilenceBeganAtRef.current ??= now;
        if (
          now - nativeSilenceBeganAtRef.current >= NATIVE_PCM_SILENCE_TIMEOUT_MS &&
          !nativeSilenceFinalizeRequestedRef.current
        ) {
          nativeSilenceFinalizeRequestedRef.current = true;
          recordingFinalizeRef.current?.();
        }
      } else {
        nativeSilenceBeganAtRef.current = undefined;
      }
      return;
    }

    if (!nativePcmRecordingRef.current || process.env.EXPO_OS === 'web') return;

    const copiedData = new Uint8Array(buffer.data.slice(0));
    nativePcmChunksRef.current.push({
      channels: buffer.channels,
      data: copiedData,
      sampleRate: buffer.sampleRate,
    });

    const rms = nativePcmRms(buffer.data);
    const now = Date.now();
    if (now - nativePcmLastMeterAtRef.current >= NATIVE_PCM_METER_THROTTLE_MS) {
      nativePcmLastMeterAtRef.current = now;
      setNativePcmDurationMillis(Math.round(buffer.timestamp * 1_000));
      setNativePcmMetering(nativePcmMeterLevel(buffer.data));
    }

    const recordingDurationMillis = recordingBeganAtRef.current > 0
      ? now - recordingBeganAtRef.current
      : 0;

    if (rms >= NATIVE_PCM_SPEECH_RMS) {
      nativeSpeechDetectedRef.current = true;
      nativeSilenceBeganAtRef.current = undefined;
      return;
    }

    if (
      !nativeSpeechDetectedRef.current ||
      recordingDurationMillis < NATIVE_SILENCE_MIN_RECORDING_MS ||
      rms > NATIVE_PCM_SILENCE_RMS
    ) {
      nativeSilenceBeganAtRef.current = undefined;
      return;
    }

    const silenceBeganAt = nativeSilenceBeganAtRef.current;
    if (silenceBeganAt === undefined) {
      nativeSilenceBeganAtRef.current = now;
      return;
    }
    if (
      now - silenceBeganAt < NATIVE_PCM_SILENCE_TIMEOUT_MS ||
      nativeSilenceFinalizeRequestedRef.current
    ) {
      return;
    }

    const finalizeRecording = recordingFinalizeRef.current;
    if (!finalizeRecording) return;
    nativeSilenceFinalizeRequestedRef.current = true;
    finalizeRecording();
  }, []);

  const { stream: nativeAudioStream } = useAudioStream({
    channels: 1,
    encoding: 'int16',
    onBuffer: handleNativePcmBuffer,
    sampleRate: 24_000,
  });

  const updateDiscoveryVoice = useCallback((next: DiscoveryVoiceState) => {
    discoveryVoiceRef.current = next;
    setDiscoveryVoice(next);
  }, []);

  const transcriptionReadiness = useCallback(async (): Promise<TranscriptionReadiness> => {
    if (transcriptionReadinessRef.current === 'ready') {
      return transcriptionReadinessRef.current;
    }

    try {
      const capabilities = await checkVoiceCapabilities({ timeoutMs: 5_000 });
      if (capabilities.transcription === 'ready') {
        transcriptionReadinessRef.current = capabilities.transcription;
      }
      return capabilities.transcription;
    } catch (error) {
      if (error instanceof MurmurApiError && error.kind === 'configuration') {
        return 'unconfigured';
      }
      return 'unreachable';
    }
  }, []);

  const pingNativeVoiceRoute = useCallback((surface: 'discovery' | 'episode') => {
    if (process.env.EXPO_OS === 'web') return;

    void checkVoiceCapabilities({ timeoutMs: 3_000 })
      .then((capabilities) => {
        voiceDebug('native-voice-route-ready', {
          apiRoot: process.env.EXPO_PUBLIC_API_URL || 'auto',
          surface,
          transcription: capabilities.transcription,
        });
      })
      .catch((error: unknown) => {
        voiceDebug('native-voice-route-failed', {
          apiRoot: process.env.EXPO_PUBLIC_API_URL || 'auto',
          code: error instanceof MurmurApiError ? error.code : undefined,
          kind: error instanceof MurmurApiError ? error.kind : undefined,
          message: error instanceof Error ? error.message : String(error),
          surface,
        });
      });
  }, []);

  const abortVoiceRequest = useCallback(() => {
    requestAbortRef.current?.abort();
    requestAbortRef.current = undefined;
  }, []);

  const resetNativeSilenceDetection = useCallback(() => {
    nativeSpeechDetectedRef.current = false;
    nativeSilenceBeganAtRef.current = undefined;
    nativeSilenceFinalizeRequestedRef.current = false;
  }, []);

  const captureActiveRecordingUri = useCallback(() => {
    if (!recordingActiveRef.current && !nativeRecorderPreparedRef.current) return;

    try {
      recordingUriRef.current = recorder.uri ?? undefined;
    } catch {
      recordingUriRef.current = undefined;
    }
  }, [recorder]);

  const stopActiveRecording = useCallback(async (): Promise<string | undefined> => {
    if (!recordingActiveRef.current && !nativeRecorderPreparedRef.current) return undefined;

    recordingActiveRef.current = false;
    nativeRecorderPreparedRef.current = false;
    recordingBeganAtRef.current = 0;
    resetNativeSilenceDetection();
    recordingFinalizeRef.current = undefined;
    if (recordingLimitTimerRef.current) clearTimeout(recordingLimitTimerRef.current);
    recordingLimitTimerRef.current = undefined;

    const capturedUri = recordingUriRef.current;
    recordingUriRef.current = undefined;
    try {
      await recorder.stop();
    } catch {
      voiceDebug('recording-stop-failed', { hadCapturedUri: Boolean(capturedUri) });
      deleteVoiceRecording(capturedUri);
      return undefined;
    }

    try {
      const statusUri = recorder.getStatus().url ?? undefined;
      const recorderUri = recorder.uri ?? undefined;
      const finalUri = recorderUri ?? statusUri ?? capturedUri;
      voiceDebug('recording-stopped', {
        hadCapturedUri: Boolean(capturedUri),
        hasStatusUri: Boolean(statusUri),
        hasRecorderUri: Boolean(recorderUri),
        hasFinalUri: Boolean(finalUri),
      });
      return finalUri;
    } catch {
      voiceDebug('recording-status-read-failed', { hadCapturedUri: Boolean(capturedUri) });
      return capturedUri;
    }
  }, [recorder, resetNativeSilenceDetection]);

  const startNativePcmCapture = useCallback(async (finalizeRecording: () => void) => {
    if (process.env.EXPO_OS === 'web' || nativePcmRecordingRef.current) return false;

    nativePcmChunksRef.current = [];
    nativePcmLastMeterAtRef.current = 0;
    setNativePcmDurationMillis(0);
    setNativePcmMetering(0);
    resetNativeSilenceDetection();
    recordingBeganAtRef.current = Date.now();
    recordingFinalizeRef.current = finalizeRecording;
    if (recordingLimitTimerRef.current) clearTimeout(recordingLimitTimerRef.current);
    recordingLimitTimerRef.current = setTimeout(() => {
      recordingFinalizeRef.current?.();
    }, NATIVE_RECORDING_AUTO_FINALIZE_MS);

    try {
      nativePcmRecordingRef.current = true;
      await nativeAudioStream.start();
      voiceDebug('native-pcm-started');
      return true;
    } catch (error) {
      nativePcmRecordingRef.current = false;
      nativePcmChunksRef.current = [];
      recordingBeganAtRef.current = 0;
      recordingFinalizeRef.current = undefined;
      setNativePcmDurationMillis(0);
      setNativePcmMetering(null);
      if (recordingLimitTimerRef.current) clearTimeout(recordingLimitTimerRef.current);
      recordingLimitTimerRef.current = undefined;
      voiceDebug('native-pcm-start-failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }, [nativeAudioStream, resetNativeSilenceDetection]);

  const stopNativePcmCapture = useCallback(async (
    retainRecording = false,
  ): Promise<string | undefined> => {
    if (!nativePcmRecordingRef.current) return undefined;

    nativePcmRecordingRef.current = false;
    const chunks = nativePcmChunksRef.current;
    nativePcmChunksRef.current = [];
    setNativePcmDurationMillis(0);
    setNativePcmMetering(null);
    resetNativeSilenceDetection();
    recordingFinalizeRef.current = undefined;
    if (recordingLimitTimerRef.current) clearTimeout(recordingLimitTimerRef.current);
    recordingLimitTimerRef.current = undefined;

    try {
      nativeAudioStream.stop();
    } catch (error) {
      voiceDebug('native-pcm-stop-failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (!retainRecording) return undefined;

    const recordingUri = writeNativePcmRecording(chunks);
    voiceDebug('native-pcm-stopped', {
      chunks: chunks.length,
      hasRecordingUri: Boolean(recordingUri),
      bytes: chunks.reduce((total, chunk) => total + chunk.data.byteLength, 0),
      sampleRate: chunks[0]?.sampleRate,
      channels: chunks[0]?.channels,
    });
    return recordingUri;
  }, [nativeAudioStream, resetNativeSilenceDetection]);

  const stopRealtimeMicrophone = useCallback(async () => {
    if (realtimeNativeCaptureRef.current) {
      realtimeNativeCaptureRef.current = false;
      try {
        nativeAudioStream.stop();
      } catch {
        // The native stream may already have stopped after an interruption.
      }
    }

    const webCapture = realtimeWebCaptureRef.current;
    realtimeWebCaptureRef.current = undefined;
    if (webCapture) await webCapture.stop();

    recordingBeganAtRef.current = 0;
    resetNativeSilenceDetection();
    recordingFinalizeRef.current = undefined;
    if (recordingLimitTimerRef.current) clearTimeout(recordingLimitTimerRef.current);
    recordingLimitTimerRef.current = undefined;
    setNativePcmDurationMillis(0);
    setNativePcmMetering(null);
    await setAudioModeAsync(PLAYBACK_AUDIO_MODE).catch(() => undefined);
  }, [nativeAudioStream, resetNativeSilenceDetection]);

  const cancelRealtimeVoice = useCallback(async () => {
    await stopRealtimeMicrophone();
    realtimeSessionRef.current?.cancel();
    realtimeSessionRef.current = undefined;
  }, [stopRealtimeMicrophone]);

  const stopWakeWordMonitoring = useCallback(async (
    nextStatus: WakeWordStatus = 'inactive',
  ) => {
    wakeWordGenerationRef.current += 1;
    if (wakeWordBufferTimerRef.current) {
      clearInterval(wakeWordBufferTimerRef.current);
      wakeWordBufferTimerRef.current = undefined;
    }
    const session = wakeWordSessionRef.current;
    wakeWordSessionRef.current = undefined;
    session?.cancel();

    if (wakeWordNativeCaptureRef.current) {
      wakeWordNativeCaptureRef.current = false;
      try {
        nativeAudioStream.stop();
      } catch {
        // The native wake stream may already be stopped.
      }
    }

    const webCapture = wakeWordWebCaptureRef.current;
    wakeWordWebCaptureRef.current = undefined;
    if (webCapture) await webCapture.stop();

    if (!realtimeNativeCaptureRef.current && !realtimeWebCaptureRef.current) {
      await setAudioModeAsync(PLAYBACK_AUDIO_MODE).catch(() => undefined);
    }
    if (mountedRef.current) setWakeWordStatus(nextStatus);
  }, [nativeAudioStream]);

  const startRealtimeMicrophone = useCallback(async (
    session: RealtimeTranscriptionSession,
    finalize: () => void,
  ) => {
    resetNativeSilenceDetection();
    recordingBeganAtRef.current = Date.now();
    recordingFinalizeRef.current = finalize;
    if (recordingLimitTimerRef.current) clearTimeout(recordingLimitTimerRef.current);
    recordingLimitTimerRef.current = setTimeout(finalize, NATIVE_RECORDING_AUTO_FINALIZE_MS);

    if (process.env.EXPO_OS === 'web') {
      realtimeWebCaptureRef.current = await startWebPcmCapture((chunk) => {
        if (realtimeSessionRef.current === session) {
          session.appendPcm(chunk.data, chunk.sampleRate, chunk.channels);
          setNativePcmMetering(nativePcmMeterLevel(chunk.data));
          const now = Date.now();
          const rms = nativePcmRms(chunk.data);
          const recordingDurationMillis = now - recordingBeganAtRef.current;
          if (rms >= NATIVE_PCM_SPEECH_RMS) {
            nativeSpeechDetectedRef.current = true;
            nativeSilenceBeganAtRef.current = undefined;
          } else if (
            nativeSpeechDetectedRef.current &&
            recordingDurationMillis >= NATIVE_SILENCE_MIN_RECORDING_MS &&
            rms <= NATIVE_PCM_SILENCE_RMS
          ) {
            nativeSilenceBeganAtRef.current ??= now;
            if (
              now - nativeSilenceBeganAtRef.current >= NATIVE_PCM_SILENCE_TIMEOUT_MS &&
              !nativeSilenceFinalizeRequestedRef.current
            ) {
              nativeSilenceFinalizeRequestedRef.current = true;
              recordingFinalizeRef.current?.();
            }
          } else {
            nativeSilenceBeganAtRef.current = undefined;
          }
        }
      });
      return;
    }

    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      throw new RealtimeVoiceError('microphone_denied', 'Microphone access is off.');
    }
    await setAudioModeAsync(RECORDING_AUDIO_MODE);
    nativePcmLastMeterAtRef.current = 0;
    setNativePcmDurationMillis(0);
    setNativePcmMetering(0);
    realtimeNativeCaptureRef.current = true;
    try {
      await nativeAudioStream.start();
    } catch (error) {
      realtimeNativeCaptureRef.current = false;
      throw error;
    }
  }, [nativeAudioStream, resetNativeSilenceDetection]);

  const startVoiceStop = useCallback((): boolean => {
    if (voiceStopInFlightRef.current) return false;

    voiceStopInFlightRef.current = true;
    voiceStopCompletionRef.current = new Promise<void>((resolve) => {
      resolveVoiceStopRef.current = resolve;
    });
    return true;
  }, []);

  const finishVoiceStop = useCallback(() => {
    voiceStopInFlightRef.current = false;
    resolveVoiceStopRef.current?.();
    resolveVoiceStopRef.current = undefined;
  }, []);

  const waitForVoiceStop = useCallback(async () => {
    if (voiceStopInFlightRef.current) {
      await voiceStopCompletionRef.current;
    }
  }, []);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(undefined), 2800);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    deleteStaleVoiceCacheFiles();
    void setAudioModeAsync(PLAYBACK_AUDIO_MODE).catch(() => undefined);

    return () => {
      mountedRef.current = false;
      operationRef.current += 1;
      transcriptRequestRef.current += 1;
      voiceStartOperationRef.current = undefined;
      finishVoiceStop();
      const abandonedRecordingUri = recordingUriRef.current;
      recordingUriRef.current = undefined;
      recordingActiveRef.current = false;
      nativeRecorderPreparedRef.current = false;
      episodeVoiceActiveRef.current = false;
      voiceSessionPreparedRef.current = false;
      resetNativeSilenceDetection();
      recordingFinalizeRef.current = undefined;
      discoveryFinalizeRef.current = undefined;
      discoveryFinalizingRef.current = false;
      nativePcmRecordingRef.current = false;
      nativePcmChunksRef.current = [];
      realtimeSessionRef.current?.cancel();
      realtimeSessionRef.current = undefined;
      realtimeNativeCaptureRef.current = false;
      const realtimeWebCapture = realtimeWebCaptureRef.current;
      realtimeWebCaptureRef.current = undefined;
      if (realtimeWebCapture) void realtimeWebCapture.stop();
      wakeWordGenerationRef.current += 1;
      if (wakeWordBufferTimerRef.current) {
        clearInterval(wakeWordBufferTimerRef.current);
        wakeWordBufferTimerRef.current = undefined;
      }
      wakeWordSessionRef.current?.cancel();
      wakeWordSessionRef.current = undefined;
      wakeWordNativeCaptureRef.current = false;
      const wakeWordWebCapture = wakeWordWebCaptureRef.current;
      wakeWordWebCaptureRef.current = undefined;
      if (wakeWordWebCapture) void wakeWordWebCapture.stop();
      if (process.env.EXPO_OS !== 'web') {
        try {
          nativeAudioStream.stop();
        } catch {
          // The native PCM stream may not have been started.
        }
      }
      if (recordingLimitTimerRef.current) clearTimeout(recordingLimitTimerRef.current);
      requestAbortRef.current?.abort();
      const recognition = recognitionRef.current;
      recognitionRef.current = undefined;
      try {
        if (recognition) {
          recognition.onresult = null;
          recognition.onerror = null;
          recognition.onend = null;
          recognition.stop();
        }
      } catch {
        // The browser recognizer may already be stopped.
      }
      deleteVoiceRecording(abandonedRecordingUri);
      void setAudioModeAsync(PLAYBACK_AUDIO_MODE).catch(() => undefined);
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, [finishVoiceStop, nativeAudioStream, resetNativeSilenceDetection]);

  useEffect(() => {
    if (!started || !episodeRef.current) return;

    const nextIssue: PlaybackIssue | undefined = playerStatus.error
      ? 'error'
      : playerStatus.didJustFinish
        ? 'ended'
        : undefined;
    if (!nextIssue) return;

    const episodeId = episodeRef.current.id;
    const update = setTimeout(() => {
      if (episodeRef.current?.id === episodeId) setPlaybackIssue(nextIssue);
    }, 0);
    return () => clearTimeout(update);
  }, [playerStatus.didJustFinish, playerStatus.error, started]);

  const loadTranscript = useCallback(async (nextEpisode: CatalogEpisode) => {
    const request = transcriptRequestRef.current + 1;
    transcriptRequestRef.current = request;
    setTranscriptStatus('loading');
    setTranscript([]);
    transcriptRef.current = [];

    if (nextEpisode.transcript?.length) {
      transcriptRef.current = nextEpisode.transcript;
      setTranscript(nextEpisode.transcript);
      setTranscriptStatus('ready');
      return nextEpisode.transcript;
    }

    try {
      const loaded = await fetchEpisodeTranscript(nextEpisode);
      if (transcriptRequestRef.current !== request || episodeRef.current?.id !== nextEpisode.id) {
        return [];
      }
      transcriptRef.current = loaded;
      setTranscript(loaded);
      setTranscriptStatus('ready');
      return loaded;
    } catch {
      if (transcriptRequestRef.current === request) {
        setTranscriptStatus('unavailable');
      }
      return [];
    }
  }, []);

  const startEpisode = useCallback(
    async (nextEpisode: CatalogEpisode) => {
      const operation = operationRef.current + 1;
      operationRef.current = operation;
      voiceStartOperationRef.current = undefined;
      discoveryFinalizingRef.current = false;
      discoveryEpisodesRef.current = [];
      discoveryFocusedEpisodeIdRef.current = undefined;
      discoveryVoiceRef.current = IDLE_DISCOVERY_VOICE;
      setDiscoveryVoice(IDLE_DISCOVERY_VOICE);
      browserTranscriptRef.current = '';
      episodeVoiceActiveRef.current = false;
      voiceSessionPreparedRef.current = false;
      recordingFinalizeRef.current = undefined;
      abortVoiceRequest();
      const recognition = recognitionRef.current;
      recognitionRef.current = undefined;
      try {
        if (recognition) {
          recognition.onresult = null;
          recognition.onerror = null;
          recognition.onend = null;
          recognition.stop();
        }
      } catch {
        // The browser recognizer may already be stopped.
      }
      player.pause();
      await stopWakeWordMonitoring();
      await stopAssistant();
      deleteVoiceRecording(await stopActiveRecording());
      await setAudioModeAsync(PLAYBACK_AUDIO_MODE).catch(() => undefined);
      if (operationRef.current !== operation) return;

      episodeRef.current = nextEpisode;
      setEpisode(nextEpisode);
      setStarted(true);
      setPlaybackIssue(undefined);
      setMode('playback');
      setResponse(undefined);
      setResponseCategory(undefined);
      setResponseProvider(undefined);
      setActivityMessage(undefined);
      setTranscriptText('');
      setTurns([]);
      returnAnchorRef.current = 0;

      try {
        player.replace(
          nextEpisode.audioAsset.bundledSource ?? {
            uri: nextEpisode.audioAsset.url,
            name: nextEpisode.title,
          },
        );
        player.play();
      } catch {
        setPlaybackIssue('error');
        setResponse('This episode could not start. You can return to discovery and try another.');
        setResponseCategory(undefined);
        setMode('error');
      }
      void loadTranscript(nextEpisode);
      void Haptics.selectionAsync().catch(() => undefined);
    },
    [
      abortVoiceRequest,
      loadTranscript,
      player,
      stopActiveRecording,
      stopAssistant,
      stopWakeWordMonitoring,
    ],
  );

  const togglePlayback = useCallback(() => {
    operationRef.current += 1;
    if (mode !== 'playback') {
      voiceSessionPreparedRef.current = false;
      abortVoiceRequest();
      void stopAssistant();
      setResponse(undefined);
      setResponseCategory(undefined);
      setResponseProvider(undefined);
      setActivityMessage(undefined);
      setTranscriptText('');
      setMode('playback');
    }
    if (playerStatus.playing) {
      player.pause();
      showNotice('Paused');
    } else {
      player.play();
      showNotice('Playing');
    }
  }, [abortVoiceRequest, mode, player, playerStatus.playing, showNotice, stopAssistant]);

  const seekTo = useCallback(
    async (seconds: number) => {
      const operation = operationRef.current + 1;
      operationRef.current = operation;
      if (mode !== 'playback') {
        voiceSessionPreparedRef.current = false;
        abortVoiceRequest();
        await stopAssistant();
        setResponse(undefined);
        setResponseCategory(undefined);
        setResponseProvider(undefined);
        setActivityMessage(undefined);
        setTranscriptText('');
        setMode('playback');
      }
      const target = clampPosition(seconds, playerStatus.duration);
      try {
        await player.seekTo(target);
      } catch {
        if (operationRef.current === operation) showNotice('Could not seek to that moment');
        return;
      }
      if (operationRef.current === operation) setPlaybackIssue(undefined);
    },
    [abortVoiceRequest, mode, player, playerStatus.duration, showNotice, stopAssistant],
  );

  const seekBy = useCallback(
    async (seconds: number) => {
      const operation = operationRef.current + 1;
      operationRef.current = operation;
      if (mode !== 'playback') {
        voiceSessionPreparedRef.current = false;
        abortVoiceRequest();
        await stopAssistant();
        setResponse(undefined);
        setResponseCategory(undefined);
        setResponseProvider(undefined);
        setActivityMessage(undefined);
        setTranscriptText('');
        setMode('playback');
      }
      const target = clampPosition(playerStatus.currentTime + seconds, playerStatus.duration);
      try {
        await player.seekTo(target);
      } catch {
        if (operationRef.current === operation) showNotice('Could not seek to that moment');
        return;
      }
      if (operationRef.current !== operation) return;
      setPlaybackIssue(undefined);
      showNotice(`${seconds < 0 ? 'Back' : 'Forward'} ${Math.abs(seconds)} seconds`);
      void Haptics.selectionAsync().catch(() => undefined);
    },
    [
      abortVoiceRequest,
      mode,
      player,
      playerStatus.currentTime,
      playerStatus.duration,
      showNotice,
      stopAssistant,
    ],
  );

  const cyclePlaybackRate = useCallback(() => {
    const currentIndex = playbackRates.findIndex(
      (rate) => Math.abs(rate - playerStatus.playbackRate) < 0.01,
    );
    const nextRate = playbackRates[(currentIndex + 1) % playbackRates.length] ?? 1;
    player.setPlaybackRate(nextRate, 'high');
    showNotice(`${nextRate}× speed`);
  }, [player, playerStatus.playbackRate, showNotice]);

  const finalizeBrowserTranscription = useCallback(async () => {
    const recognition = recognitionRef.current;
    if (!recognition) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const previousResult = recognition.onresult;
      const previousError = recognition.onerror;
      const previousEnd = recognition.onend;
      const settle = () => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (recognitionRef.current === recognition) recognitionRef.current = undefined;
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        resolve();
      };

      recognition.onresult = (event) => previousResult?.(event);
      recognition.onerror = (event) => {
        if (event.error !== 'aborted') previousError?.(event);
        settle();
      };
      recognition.onend = () => {
        previousEnd?.();
        settle();
      };
      timeout = setTimeout(settle, 900);

      try {
        recognition.stop();
      } catch {
        settle();
      }
    });
  }, []);

  const stopVoiceCapture = useCallback(
    async (retainRecording = false, finalizeBrowser = false): Promise<string | undefined> => {
      await cancelRealtimeVoice();
      let recordingUri: string | undefined;
      const recognition = recognitionRef.current;
      episodeVoiceActiveRef.current = false;

      if (process.env.EXPO_OS === 'web' && finalizeBrowser) {
        await finalizeBrowserTranscription();
      } else {
        recognitionRef.current = undefined;
        try {
          if (recognition) {
            recognition.onresult = null;
            recognition.onerror = null;
            recognition.onend = null;
            recognition.stop();
          }
        } catch {
          // The browser recognizer may already be stopped.
        }
      }

      const streamUri = await stopNativePcmCapture(retainRecording);
      if (streamUri) {
        await setAudioModeAsync(PLAYBACK_AUDIO_MODE).catch(() => undefined);
        return streamUri;
      }

      const recorderUri = await stopActiveRecording();
      if (recorderUri) {
        if (process.env.EXPO_OS === 'web') {
          if (retainRecording) recordingUri = recorderUri;
          else revokeBrowserRecording(recorderUri);
        } else if (retainRecording) {
          recordingUri = await preserveNativeRecordingForUpload(recorderUri);
        } else {
          deleteNativeRecording(recorderUri);
        }
      }
      await setAudioModeAsync(PLAYBACK_AUDIO_MODE).catch(() => undefined);
      return retainRecording ? recordingUri : undefined;
    },
    [
      cancelRealtimeVoice,
      finalizeBrowserTranscription,
      stopActiveRecording,
      stopNativePcmCapture,
    ],
  );

  const startBrowserTranscription = useCallback((
    callbacks: BrowserTranscriptionCallbacks = {},
  ): boolean => {
    if (process.env.EXPO_OS !== 'web') return false;
    const speechGlobal = globalThis as SpeechCapableGlobal;
    const Recognition = speechGlobal.SpeechRecognition ?? speechGlobal.webkitSpeechRecognition;
    if (!Recognition) return false;

    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    browserTranscriptRef.current = '';
    recognition.onresult = (event) => {
      if (recognitionRef.current !== recognition) return;
      let heard = '';
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result?.[0]?.transcript) heard += result[0].transcript;
      }
      if (heard.trim()) {
        browserTranscriptRef.current = heard.trim();
        if (callbacks.onTranscript) {
          callbacks.onTranscript(heard.trim());
        } else {
          setTranscriptText(heard.trim());
        }
      }
    };
    recognition.onerror = (event) => {
      if (recognitionRef.current !== recognition) return;
      recognitionRef.current = undefined;
      if (callbacks.onError) {
        callbacks.onError(event.error);
      } else {
        showNotice(browserSpeechFailureMessage(event.error));
      }
    };
    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return;
      recognitionRef.current = undefined;
      if (callbacks.onEnd) {
        callbacks.onEnd();
      } else {
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      if (recognitionRef.current === recognition) recognitionRef.current = undefined;
      return false;
    }
    return true;
  }, [showNotice]);

  const prepareVoice = useCallback((): number | undefined => {
    if (!episodeRef.current || voiceStopInFlightRef.current) return undefined;

    if (!voiceSessionPreparedRef.current) {
      returnAnchorRef.current = player.currentTime;
      resumeAfterVoiceRef.current = player.playing;
      voiceSessionPreparedRef.current = true;
    }
    player.pause();
    return returnAnchorRef.current;
  }, [player]);

  const beginVoice = useCallback(async () => {
    const activeEpisode = episodeRef.current;
    if (!activeEpisode || voiceStopInFlightRef.current) return;

    // Realtime is the default voice path. The legacy recorder remains behind an
    // explicit development escape hatch while the migration settles; no app
    // build opts into it.
    if (process.env.EXPO_PUBLIC_MURMUR_REALTIME_VOICE !== 'off') {
      const activeRealtimeSession = realtimeSessionRef.current;
      if (episodeVoiceActiveRef.current && activeRealtimeSession) {
        episodeVoiceActiveRef.current = false;
        setMode('processing');
        setActivityMessage('Understanding…');
        await stopRealtimeMicrophone();
        void activeRealtimeSession.finish().catch(() => undefined);
        return;
      }
      if (voiceStartOperationRef.current !== undefined) return;

      const operation = operationRef.current + 1;
      operationRef.current = operation;
      voiceStartOperationRef.current = operation;
      abortVoiceRequest();
      prepareVoice();
      await stopWakeWordMonitoring();
      browserTranscriptRef.current = '';
      setTranscriptText('');
      setResponse(undefined);
      setResponseCategory(undefined);
      setResponseProvider(undefined);
      setActivityMessage('Connecting live voice…');
      setMode('processing');
      await stopAssistant();
      await cancelRealtimeVoice();

      let finalHandled = false;
      const session = new RealtimeTranscriptionSession({
        onSpeechStarted: () => {
          if (
            operationRef.current !== operation ||
            episodeRef.current?.id !== activeEpisode.id
          ) return;
          setActivityMessage(undefined);
          setMode('listening');
        },
        onPartialTranscript: (nextTranscript) => {
          if (
            operationRef.current !== operation ||
            episodeRef.current?.id !== activeEpisode.id
          ) return;
          browserTranscriptRef.current = nextTranscript;
          setTranscriptText(nextTranscript);
          setActivityMessage(undefined);
          setMode('listening');
        },
        onSpeechStopped: () => {
          if (
            operationRef.current !== operation ||
            episodeRef.current?.id !== activeEpisode.id
          ) return;
          episodeVoiceActiveRef.current = false;
          setMode('processing');
          setActivityMessage('Understanding…');
          void stopRealtimeMicrophone();
        },
        onFinalTranscript: (finalTranscript) => {
          if (finalHandled) return;
          finalHandled = true;
          void (async () => {
            await stopRealtimeMicrophone();
            if (realtimeSessionRef.current === session) {
              session.cancel();
              realtimeSessionRef.current = undefined;
            }
            if (
              operationRef.current !== operation ||
              episodeRef.current?.id !== activeEpisode.id
            ) return;
            const cleaned = finalTranscript.trim();
            if (!cleaned) {
              setResponse('I didn’t hear speech. Try voice again.');
              setActivityMessage(undefined);
              setMode('error');
              return;
            }
            browserTranscriptRef.current = cleaned;
            setTranscriptText(cleaned);
            setMode('processing');
            setActivityMessage('Understanding…');
            await waitForTranscriptReveal();
            if (
              operationRef.current === operation &&
              episodeRef.current?.id === activeEpisode.id
            ) {
              await submitIntentRef.current?.(cleaned);
            }
          })();
        },
        onError: (error) => {
          if (
            realtimeSessionRef.current !== session ||
            operationRef.current !== operation ||
            episodeRef.current?.id !== activeEpisode.id
          ) return;
          voiceDebug('episode-realtime-failed', {
            code: error instanceof RealtimeVoiceError ? error.code : undefined,
            message: error.message,
          });
          episodeVoiceActiveRef.current = false;
          void cancelRealtimeVoice();
          setResponse('Live voice lost its connection. Your place is safe; try again.');
          setResponseCategory(undefined);
          setResponseProvider(undefined);
          setActivityMessage(undefined);
          setMode('error');
        },
      });
      realtimeSessionRef.current = session;

      try {
        assertWebPcmCaptureAvailable();
        await session.connect('episode');
        if (
          operationRef.current !== operation ||
          episodeRef.current?.id !== activeEpisode.id
        ) {
          await cancelRealtimeVoice();
          return;
        }
        await startRealtimeMicrophone(session, () => {
          void beginVoiceRef.current?.();
        });
        if (
          operationRef.current !== operation ||
          episodeRef.current?.id !== activeEpisode.id
        ) {
          await cancelRealtimeVoice();
          return;
        }
        episodeVoiceActiveRef.current = true;
        setActivityMessage(undefined);
        setMode('listening');
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      } catch (error) {
        await cancelRealtimeVoice();
        if (
          operationRef.current !== operation ||
          episodeRef.current?.id !== activeEpisode.id
        ) return;
        voiceDebug('episode-realtime-start-failed', {
          code: error instanceof RealtimeVoiceError ? error.code : undefined,
          message: error instanceof Error ? error.message : String(error),
        });
        setResponse(realtimeVoiceFailureMessage(error, true));
        setResponseCategory(undefined);
        setResponseProvider(undefined);
        setActivityMessage(undefined);
        setMode('error');
      } finally {
        if (voiceStartOperationRef.current === operation) {
          voiceStartOperationRef.current = undefined;
        }
      }
      return;
    }

    if (episodeVoiceActiveRef.current) {
      startVoiceStop();
      episodeVoiceActiveRef.current = false;
      const operation = operationRef.current + 1;
      operationRef.current = operation;
      voiceStartOperationRef.current = undefined;
      const recordedDurationMillis = Math.max(
        recorderState.durationMillis,
        recordingBeganAtRef.current > 0
          ? Date.now() - recordingBeganAtRef.current
          : 0,
      );
      let recordingUri: string | undefined;
      try {
        setActivityMessage('Stopping recording…');
        recordingUri = await stopVoiceCapture(
          true,
          process.env.EXPO_OS === 'web',
        );
      } finally {
        finishVoiceStop();
      }

      if (
        operationRef.current !== operation ||
        episodeRef.current?.id !== activeEpisode.id
      ) {
        deleteVoiceRecording(recordingUri);
        return;
      }

      if (process.env.EXPO_OS === 'web') {
        const webTranscript = browserTranscriptRef.current.trim();
        if (webTranscript) {
          deleteVoiceRecording(recordingUri);
          recordingUri = undefined;
          setTranscriptText(webTranscript);
          setMode('processing');
          setActivityMessage('Heard you. Routing that…');
          await waitForTranscriptReveal();
          if (
            operationRef.current !== operation ||
            episodeRef.current?.id !== activeEpisode.id
          ) {
            return;
          }
          await submitIntentRef.current?.(webTranscript);
          return;
        }
      }

      if (!recordingUri || recordedDurationMillis < 350) {
        const hasRecordingFile = Boolean(recordingUri);
        voiceDebug('recording-unusable', {
          hasRecordingUri: hasRecordingFile,
          recordedDurationMillis,
        });
        deleteVoiceRecording(recordingUri);
        recordingUri = undefined;
        setResponse(
          hasRecordingFile
            ? 'I did not catch enough audio. Try voice again or return.'
            : 'Recording stopped, but Expo did not return an audio file to transcribe.',
        );
        setResponseCategory(undefined);
        setResponseProvider(undefined);
        setActivityMessage(undefined);
        setMode('error');
        return;
      }

      const controller = new AbortController();
      abortVoiceRequest();
      requestAbortRef.current = controller;
      setActivityMessage('Uploading audio for transcription…');
      setMode('processing');

      try {
        const metadata = recordingMetadata(recordingUri);
        voiceDebug('transcribe-upload-start', {
          apiRoot: process.env.EXPO_PUBLIC_API_URL || 'auto',
          recordedDurationMillis,
          mimeType: metadata.mimeType,
          name: metadata.name,
        });
        const result = await transcribeRecording(
          recordingUri,
          metadata,
          { signal: controller.signal },
        );
        if (
          operationRef.current !== operation ||
          episodeRef.current?.id !== activeEpisode.id ||
          controller.signal.aborted
        ) {
          return;
        }
        requestAbortRef.current = undefined;
        voiceDebug('transcribe-upload-success', {
          transcriptLength: result.transcript.length,
          provider: result.provider,
          model: result.model,
        });
        if (!result.transcript) {
          setResponse('I did not catch a clear request. Try voice again or return.');
          setResponseCategory(undefined);
          setResponseProvider(undefined);
          setActivityMessage(undefined);
          setMode('error');
          return;
        }

        deleteVoiceRecording(recordingUri);
        recordingUri = undefined;
        setTranscriptText(result.transcript);
        setMode('processing');
        setActivityMessage('Heard you. Routing that…');
        await waitForTranscriptReveal();
        if (
          operationRef.current !== operation ||
          episodeRef.current?.id !== activeEpisode.id
        ) {
          return;
        }
        await submitIntentRef.current?.(result.transcript);
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error instanceof MurmurApiError && error.kind === 'cancelled') ||
          operationRef.current !== operation
        ) {
          return;
        }
        requestAbortRef.current = undefined;
        voiceDebug('transcribe-upload-failed', {
          message: error instanceof Error ? error.message : String(error),
          code: error instanceof MurmurApiError ? error.code : undefined,
          kind: error instanceof MurmurApiError ? error.kind : undefined,
        });
        setResponse(transcriptionFailureMessage(error));
        setResponseCategory(undefined);
        setResponseProvider(undefined);
        setActivityMessage(undefined);
        setMode('error');
      } finally {
        deleteVoiceRecording(recordingUri);
      }
      return;
    }

    if (voiceStartOperationRef.current !== undefined) return;

    const operation = operationRef.current + 1;
    operationRef.current = operation;
    voiceStartOperationRef.current = operation;
    abortVoiceRequest();
    prepareVoice();
    await stopWakeWordMonitoring();
    browserTranscriptRef.current = '';
    setTranscriptText('');
    setResponse(undefined);
    setResponseCategory(undefined);
    setResponseProvider(undefined);
    setActivityMessage(undefined);
    setActivityMessage('Opening the microphone…');
    setMode('processing');
    pingNativeVoiceRoute('episode');
    await stopAssistant();

    if (
      operationRef.current !== operation ||
      episodeRef.current?.id !== activeEpisode.id
    ) {
      if (voiceStartOperationRef.current === operation) {
        voiceStartOperationRef.current = undefined;
      }
      return;
    }

    if (process.env.EXPO_OS === 'web') {
      const availableCaptureCapabilities = webVoiceCaptureCapabilities();
      const captureCapabilities = {
        ...availableCaptureCapabilities,
        liveTranscription:
          availableCaptureCapabilities.liveTranscription &&
          !browserRecognitionUnavailableRef.current,
      };
      const captureStrategy = resolveWebVoiceCaptureStrategy(captureCapabilities);
      let startedRecording = false;
      episodeVoiceActiveRef.current = true;
      const startedTranscription = captureStrategy === 'browser-transcription'
        ? startBrowserTranscription({
            onTranscript: setTranscriptText,
            onError: (reason) => {
              if (
                operationRef.current === operation &&
                episodeRef.current?.id === activeEpisode.id &&
                episodeVoiceActiveRef.current
              ) {
                if (reason !== 'no-speech') {
                  browserRecognitionUnavailableRef.current = true;
                }
                episodeVoiceActiveRef.current = false;
                void stopVoiceCapture();
                setActivityMessage(undefined);
                setResponse(browserSpeechFailureMessage(reason));
                setResponseCategory(undefined);
                setResponseProvider(undefined);
                setMode('error');
              }
            },
            onEnd: () => {
              if (
                operationRef.current === operation &&
                episodeRef.current?.id === activeEpisode.id &&
                episodeVoiceActiveRef.current
              ) {
                void beginVoiceRef.current?.();
              }
            },
          })
        : false;

      // Browser speech recognition is the preferred path. Only open a second
      // microphone capture when recognition is absent or failed to start.
      if (!startedTranscription && captureCapabilities.recordingUpload) {
        const readiness = await transcriptionReadiness();
        if (
          operationRef.current !== operation ||
          episodeRef.current?.id !== activeEpisode.id
        ) {
          voiceStartOperationRef.current = undefined;
          return;
        }
        if (readiness !== 'ready') {
          episodeVoiceActiveRef.current = false;
          setResponse(
            readiness === 'unconfigured'
              ? 'Voice transcription isn’t connected in this preview yet.'
              : 'The Murmur voice service can’t be reached. Check the connection and try again.',
          );
          setResponseCategory(undefined);
          setResponseProvider(undefined);
          setActivityMessage(undefined);
          setMode('error');
          voiceStartOperationRef.current = undefined;
          return;
        }
        try {
          await setAudioModeAsync(RECORDING_AUDIO_MODE);
          await recorder.prepareToRecordAsync();
          recorder.record();
          recordingActiveRef.current = true;
          captureActiveRecordingUri();
          resetNativeSilenceDetection();
          recordingBeganAtRef.current = Date.now();
          recordingFinalizeRef.current = () => {
            void beginVoiceRef.current?.();
          };
          if (recordingLimitTimerRef.current) clearTimeout(recordingLimitTimerRef.current);
          recordingLimitTimerRef.current = setTimeout(() => {
            recordingFinalizeRef.current?.();
          }, NATIVE_RECORDING_AUTO_FINALIZE_MS);
          startedRecording = true;
        } catch {
          recordingActiveRef.current = false;
          recordingBeganAtRef.current = 0;
          recordingFinalizeRef.current = undefined;
          if (recordingLimitTimerRef.current) clearTimeout(recordingLimitTimerRef.current);
          recordingLimitTimerRef.current = undefined;
        }
      }

      if (
        operationRef.current !== operation ||
        episodeRef.current?.id !== activeEpisode.id
      ) {
        if (startedRecording) await stopVoiceCapture();
        if (voiceStartOperationRef.current === operation) {
          voiceStartOperationRef.current = undefined;
        }
        return;
      }

      if (!startedTranscription && !startedRecording) {
        episodeVoiceActiveRef.current = false;
        setResponse(
          captureStrategy === 'unavailable'
            ? 'This preview browser does not expose microphone capture. Open Murmur in Chrome, Safari, or Expo Go.'
            : 'Voice capture could not start in this browser. Check microphone access and try again.',
        );
        setResponseCategory(undefined);
        setResponseProvider(undefined);
        setMode('error');
      }
      setActivityMessage(undefined);
      if (startedTranscription || startedRecording) {
        setMode('listening');
      }
      voiceStartOperationRef.current = undefined;
      return;
    }

    try {
      const permission = await requestRecordingPermissionsAsync();
      if (
        operationRef.current !== operation ||
        episodeRef.current?.id !== activeEpisode.id
      ) {
        return;
      }
      if (!permission.granted) {
        setResponse('Microphone access is off. Your episode is still paused at the same moment.');
        setActivityMessage(undefined);
        setMode('error');
        return;
      }

      await setAudioModeAsync(RECORDING_AUDIO_MODE);
      if (operationRef.current !== operation) {
        await stopVoiceCapture();
        return;
      }
      const startedNativePcm = await startNativePcmCapture(() => {
        void beginVoiceRef.current?.();
      });
      if (operationRef.current !== operation) {
        await stopVoiceCapture();
        return;
      }
      if (startedNativePcm) {
        episodeVoiceActiveRef.current = true;
        setActivityMessage(undefined);
        setMode('listening');
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
        return;
      }

      voiceDebug('native-pcm-fallback-to-recorder');
      await recorder.prepareToRecordAsync();
      if (!mountedRef.current) return;
      nativeRecorderPreparedRef.current = true;
      captureActiveRecordingUri();
      if (operationRef.current !== operation) {
        await stopVoiceCapture();
        return;
      }
      recorder.record();
      recordingActiveRef.current = true;
      captureActiveRecordingUri();
      episodeVoiceActiveRef.current = true;
      resetNativeSilenceDetection();
      recordingBeganAtRef.current = Date.now();
      recordingFinalizeRef.current = () => {
        void beginVoiceRef.current?.();
      };
      if (recordingLimitTimerRef.current) clearTimeout(recordingLimitTimerRef.current);
      recordingLimitTimerRef.current = setTimeout(() => {
        recordingFinalizeRef.current?.();
      }, NATIVE_RECORDING_AUTO_FINALIZE_MS);
      setActivityMessage(undefined);
      setMode('listening');
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    } catch {
      await stopVoiceCapture();
      if (operationRef.current !== operation) return;
      setResponse('Voice capture did not start. Your place is safe; check microphone access and try again.');
      setActivityMessage(undefined);
      setMode('error');
    } finally {
      if (voiceStartOperationRef.current === operation) {
        voiceStartOperationRef.current = undefined;
      }
    }
  }, [
    abortVoiceRequest,
    cancelRealtimeVoice,
    captureActiveRecordingUri,
    pingNativeVoiceRoute,
    prepareVoice,
    recorder,
    recorderState.durationMillis,
    resetNativeSilenceDetection,
    startNativePcmCapture,
    startRealtimeMicrophone,
    startBrowserTranscription,
    transcriptionReadiness,
    finishVoiceStop,
    startVoiceStop,
    stopAssistant,
    stopVoiceCapture,
    stopRealtimeMicrophone,
    stopWakeWordMonitoring,
  ]);

  useEffect(() => {
    beginVoiceRef.current = beginVoice;
  }, [beginVoice]);

  const startWakeWordMonitoring = useCallback(async () => {
    const activeEpisode = episodeRef.current;
    if (
      !activeEpisode ||
      wakeWordSessionRef.current ||
      realtimeSessionRef.current ||
      voiceStopInFlightRef.current ||
      process.env.EXPO_PUBLIC_MURMUR_WAKE_WORD === 'off'
    ) {
      return;
    }

    const episodeId = activeEpisode.id;
    const generation = wakeWordGenerationRef.current + 1;
    wakeWordGenerationRef.current = generation;
    setWakeWordStatus('arming');

    let activated = false;
    let voiceOperation: number | undefined;
    let finalHandled = false;
    let session: RealtimeTranscriptionSession;

    const isCurrentEpisode = () =>
      mountedRef.current &&
      episodeRef.current?.id === episodeId &&
      wakeWordGenerationRef.current === generation;

    const activate = (liveTranscript: string) => {
      if (activated || !isCurrentEpisode()) return;
      const wakeMatch = matchMurmurWakeWord(liveTranscript);
      if (!wakeMatch.matched) return;

      activated = true;
      if (wakeWordBufferTimerRef.current) {
        clearInterval(wakeWordBufferTimerRef.current);
        wakeWordBufferTimerRef.current = undefined;
      }
      voiceOperation = operationRef.current + 1;
      operationRef.current = voiceOperation;
      abortVoiceRequest();
      const playbackPositionSeconds = prepareVoice() ?? player.currentTime;

      wakeWordSessionRef.current = undefined;
      realtimeSessionRef.current = session;
      if (wakeWordNativeCaptureRef.current) {
        wakeWordNativeCaptureRef.current = false;
        realtimeNativeCaptureRef.current = true;
      }
      const webCapture = wakeWordWebCaptureRef.current;
      wakeWordWebCaptureRef.current = undefined;
      if (webCapture) realtimeWebCaptureRef.current = webCapture;

      resetNativeSilenceDetection();
      nativeSpeechDetectedRef.current = true;
      recordingBeganAtRef.current = Date.now();
      recordingFinalizeRef.current = () => {
        void beginVoiceRef.current?.();
      };
      if (recordingLimitTimerRef.current) clearTimeout(recordingLimitTimerRef.current);
      recordingLimitTimerRef.current = setTimeout(() => {
        recordingFinalizeRef.current?.();
      }, NATIVE_RECORDING_AUTO_FINALIZE_MS);

      browserTranscriptRef.current = wakeMatch.request;
      episodeVoiceActiveRef.current = true;
      setTranscriptText(wakeMatch.request);
      setResponse(undefined);
      setResponseCategory(undefined);
      setResponseProvider(undefined);
      setActivityMessage(undefined);
      setMode('listening');
      setWakeWordStatus('inactive');
      wakeWordActivationIdRef.current += 1;
      setWakeWordActivation({
        id: wakeWordActivationIdRef.current,
        playbackPositionSeconds,
      });
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    };

    session = new RealtimeTranscriptionSession({
      onPartialTranscript: (liveTranscript) => {
        if (!isCurrentEpisode()) return;
        if (!activated) {
          activate(liveTranscript);
          return;
        }

        const wakeMatch = matchMurmurWakeWord(liveTranscript);
        const request = wakeMatch.matched ? wakeMatch.request : liveTranscript.trim();
        browserTranscriptRef.current = request;
        setTranscriptText(request);
        setActivityMessage(undefined);
        setMode('listening');
      },
      onFinalTranscript: (finalTranscript) => {
        if (!activated) activate(finalTranscript);
        if (!activated || finalHandled) return;
        finalHandled = true;
        void (async () => {
          await stopRealtimeMicrophone();
          if (realtimeSessionRef.current === session) {
            session.cancel();
            realtimeSessionRef.current = undefined;
          }
          episodeVoiceActiveRef.current = false;
          if (
            !isCurrentEpisode() ||
            voiceOperation === undefined ||
            operationRef.current !== voiceOperation
          ) {
            return;
          }

          const wakeMatch = matchMurmurWakeWord(finalTranscript);
          const request = (wakeMatch.matched ? wakeMatch.request : finalTranscript).trim();
          if (!request) {
            setTranscriptText('');
            setActivityMessage('Listening for your question…');
            setMode('processing');
            await beginVoiceRef.current?.();
            return;
          }

          browserTranscriptRef.current = request;
          setTranscriptText(request);
          setMode('processing');
          setActivityMessage('Understanding…');
          await waitForTranscriptReveal();
          if (
            isCurrentEpisode() &&
            voiceOperation !== undefined &&
            operationRef.current === voiceOperation
          ) {
            await submitIntentRef.current?.(request);
          }
        })();
      },
      onError: (error) => {
        if (!isCurrentEpisode()) return;
        voiceDebug('wake-word-realtime-failed', {
          activated,
          code: error instanceof RealtimeVoiceError ? error.code : undefined,
          message: error.message,
        });
        if (!activated) {
          void stopWakeWordMonitoring('unavailable');
          return;
        }

        episodeVoiceActiveRef.current = false;
        void cancelRealtimeVoice();
        setResponse('Live voice lost its connection. Your place is safe; tap the orb to try again.');
        setResponseCategory(undefined);
        setResponseProvider(undefined);
        setActivityMessage(undefined);
        setMode('error');
      },
    });
    wakeWordSessionRef.current = session;

    try {
      assertWebPcmCaptureAvailable();
      await session.connect('episode');
      if (!isCurrentEpisode() || wakeWordSessionRef.current !== session) {
        session.cancel();
        return;
      }

      if (process.env.EXPO_OS === 'web') {
        let capture: WebPcmCapture | undefined;
        capture = await startWebPcmCapture((chunk) => {
          if (
            wakeWordSessionRef.current !== session &&
            realtimeSessionRef.current !== session
          ) {
            return;
          }
          session.appendPcm(chunk.data, chunk.sampleRate, chunk.channels);
          if (!activated) return;

          setNativePcmMetering(nativePcmMeterLevel(chunk.data));
          const now = Date.now();
          const rms = nativePcmRms(chunk.data);
          if (rms >= NATIVE_PCM_SPEECH_RMS) {
            nativeSpeechDetectedRef.current = true;
            nativeSilenceBeganAtRef.current = undefined;
          } else if (rms <= NATIVE_PCM_SILENCE_RMS) {
            nativeSilenceBeganAtRef.current ??= now;
            if (
              now - nativeSilenceBeganAtRef.current >= NATIVE_PCM_SILENCE_TIMEOUT_MS &&
              !nativeSilenceFinalizeRequestedRef.current
            ) {
              nativeSilenceFinalizeRequestedRef.current = true;
              recordingFinalizeRef.current?.();
            }
          } else {
            nativeSilenceBeganAtRef.current = undefined;
          }
        });
        if (!isCurrentEpisode() || wakeWordSessionRef.current !== session) {
          await capture.stop();
          session.cancel();
          return;
        }
        wakeWordWebCaptureRef.current = capture;
      } else {
        const permission = await requestRecordingPermissionsAsync();
        if (!permission.granted) {
          throw new RealtimeVoiceError('microphone_denied', 'Microphone access is off.');
        }
        await setAudioModeAsync(RECORDING_AUDIO_MODE);
        if (!isCurrentEpisode() || wakeWordSessionRef.current !== session) {
          session.cancel();
          return;
        }
        wakeWordNativeCaptureRef.current = true;
        await nativeAudioStream.start();
      }

      if (isCurrentEpisode() && wakeWordSessionRef.current === session) {
        if (wakeWordBufferTimerRef.current) {
          clearInterval(wakeWordBufferTimerRef.current);
        }
        wakeWordBufferTimerRef.current = setInterval(() => {
          if (
            !activated &&
            isCurrentEpisode() &&
            wakeWordSessionRef.current === session
          ) {
            session.clearInputBuffer();
          }
        }, WAKE_WORD_BUFFER_RESET_MS);
        setWakeWordStatus('ready');
      }
    } catch (error) {
      if (!isCurrentEpisode()) return;
      voiceDebug('wake-word-start-failed', {
        code: error instanceof RealtimeVoiceError ? error.code : undefined,
        message: error instanceof Error ? error.message : String(error),
      });
      await stopWakeWordMonitoring('unavailable');
      showNotice('Wake phrase unavailable · tap Ask');
    }
  }, [
    abortVoiceRequest,
    cancelRealtimeVoice,
    nativeAudioStream,
    player,
    prepareVoice,
    resetNativeSilenceDetection,
    showNotice,
    stopRealtimeMicrophone,
    stopWakeWordMonitoring,
  ]);

  useEffect(() => {
    const shouldMonitor =
      process.env.EXPO_PUBLIC_MURMUR_WAKE_WORD !== 'off' &&
      started &&
      playerStatus.playing &&
      mode === 'playback' &&
      !playbackIssue;

    if (shouldMonitor) {
      const timer = setTimeout(() => {
        void startWakeWordMonitoring();
      }, 0);
      return () => clearTimeout(timer);
    }
    if (wakeWordSessionRef.current) void stopWakeWordMonitoring();
    return undefined;
  }, [
    mode,
    playbackIssue,
    playerStatus.playing,
    startWakeWordMonitoring,
    started,
    stopWakeWordMonitoring,
  ]);

  useEffect(() => {
    if (recorderState.url) {
      recordingUriRef.current = recorderState.url;
      voiceDebug('recorder-state-url', {
        isRecording: recorderState.isRecording,
        durationMillis: recorderState.durationMillis,
      });
    }
  }, [recorderState.durationMillis, recorderState.isRecording, recorderState.url]);

  useEffect(() => {
    if (
      recordingActiveRef.current &&
      !recorderState.isRecording &&
      Date.now() - recordingBeganAtRef.current > 500 &&
      !voiceStopInFlightRef.current &&
      recordingFinalizeRef.current
    ) {
      recordingFinalizeRef.current();
    }
  }, [recorderState.isRecording]);

  useEffect(() => {
    if (
      process.env.EXPO_OS === 'web' ||
      !recordingActiveRef.current ||
      !recorderState.isRecording ||
      voiceStopInFlightRef.current
    ) {
      return;
    }

    const metering = recorderState.metering;
    if (typeof metering !== 'number' || !Number.isFinite(metering)) return;

    const now = Date.now();
    const recordingDurationMillis = recordingBeganAtRef.current > 0
      ? now - recordingBeganAtRef.current
      : recorderState.durationMillis;

    if (metering >= NATIVE_SPEECH_THRESHOLD_DB) {
      nativeSpeechDetectedRef.current = true;
      nativeSilenceBeganAtRef.current = undefined;
      return;
    }

    if (
      !nativeSpeechDetectedRef.current ||
      recordingDurationMillis < NATIVE_SILENCE_MIN_RECORDING_MS ||
      metering > NATIVE_SILENCE_THRESHOLD_DB
    ) {
      nativeSilenceBeganAtRef.current = undefined;
      return;
    }

    const silenceBeganAt = nativeSilenceBeganAtRef.current;
    if (silenceBeganAt === undefined) {
      nativeSilenceBeganAtRef.current = now;
      return;
    }
    if (
      now - silenceBeganAt < NATIVE_SILENCE_TIMEOUT_MS ||
      nativeSilenceFinalizeRequestedRef.current
    ) {
      return;
    }

    const finalizeRecording = recordingFinalizeRef.current;
    if (!finalizeRecording) return;
    nativeSilenceFinalizeRequestedRef.current = true;
    finalizeRecording();
  }, [recorderState.durationMillis, recorderState.isRecording, recorderState.metering]);

  const resolveDiscoveryRequest = useCallback(async ({
    utterance,
    episodes,
    focusedEpisodeId,
    operation,
  }: {
    utterance: string;
    episodes: readonly CatalogEpisode[];
    focusedEpisodeId?: string;
    operation: number;
  }) => {
    const selection = resolveDiscoveryVoiceSelection({
      utterance,
      episodes,
      focusedEpisodeId,
    });

    if (selection.kind === 'match') {
      updateDiscoveryVoice({
        phase: 'processing',
        transcript: utterance,
        message: `Opening ${selection.episode.title}…`,
      });
      await startEpisode(selection.episode);
      return;
    }
    if (selection.kind === 'ambiguous') {
      updateDiscoveryVoice({
        errorKind: 'podcast-search',
        phase: 'error',
        transcript: utterance,
        message: 'I heard more than one local match. Say the full episode title.',
      });
      return;
    }

    updateDiscoveryVoice({
      phase: 'processing',
      transcript: utterance,
      message: 'Searching podcasts…',
    });
    const controller = new AbortController();
    requestAbortRef.current = controller;
    try {
      const result = await searchPodcast(utterance, { signal: controller.signal });
      if (
        controller.signal.aborted ||
        operationRef.current !== operation ||
        episodeRef.current
      ) {
        return;
      }

      const discoveredEpisode = decorateRemoteEpisode(result.episode, episodes.length);
      updateDiscoveryVoice({
        phase: 'processing',
        transcript: utterance,
        message: `Opening ${discoveredEpisode.title}…`,
      });
      await startEpisode(discoveredEpisode);
    } catch (error) {
      if (
        controller.signal.aborted ||
        operationRef.current !== operation ||
        (error instanceof MurmurApiError && error.kind === 'cancelled')
      ) {
        return;
      }
      voiceDebug('podcast-directory-search-failed', {
        code: error instanceof MurmurApiError ? error.code : undefined,
        message: error instanceof Error ? error.message : String(error),
      });
      updateDiscoveryVoice({
        errorKind: 'podcast-search',
        phase: 'error',
        transcript: utterance,
        message: podcastSearchFailureMessage(error),
      });
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = undefined;
    }
  }, [startEpisode, updateDiscoveryVoice]);

  const finalizeDiscoveryVoice = useCallback(async () => {
    const realtimeSession = realtimeSessionRef.current;
    if (
      realtimeSession &&
      discoveryVoiceRef.current.phase === 'listening' &&
      !discoveryFinalizingRef.current
    ) {
      discoveryFinalizingRef.current = true;
      updateDiscoveryVoice({
        phase: 'processing',
        transcript: discoveryVoiceRef.current.transcript,
        message: 'Understanding…',
      });
      await stopRealtimeMicrophone();
      void realtimeSession.finish().catch(() => undefined);
      return;
    }

    if (
      discoveryVoiceRef.current.phase !== 'listening' ||
      discoveryFinalizingRef.current ||
      voiceStopInFlightRef.current
    ) {
      return;
    }

    discoveryFinalizingRef.current = true;
    startVoiceStop();
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    voiceStartOperationRef.current = undefined;
    const episodes = discoveryEpisodesRef.current;
    const focusedEpisodeId = discoveryFocusedEpisodeIdRef.current;
    const recordedDurationMillis = Math.max(
      recorderState.durationMillis,
      recordingBeganAtRef.current > 0
        ? Date.now() - recordingBeganAtRef.current
        : 0,
    );
    let recordingUri: string | undefined;

    updateDiscoveryVoice({
      phase: 'processing',
      transcript: discoveryVoiceRef.current.transcript,
      message: 'Finding your episode…',
    });
    abortVoiceRequest();

    try {
      recordingUri = await stopVoiceCapture(
        true,
        process.env.EXPO_OS === 'web',
      );
      if (operationRef.current !== operation || episodeRef.current) return;

      let utterance = process.env.EXPO_OS === 'web'
        ? browserTranscriptRef.current.trim()
        : '';
      if (!utterance) {
        if (!recordingUri || recordedDurationMillis < 350) {
          voiceDebug('discovery-recording-unusable', {
            hasRecordingUri: Boolean(recordingUri),
            recordedDurationMillis,
          });
          updateDiscoveryVoice({
            phase: 'error',
            transcript: '',
            message: recordingUri
              ? 'I didn’t catch that. Try voice again.'
              : 'Recording stopped, but Expo did not return an audio file to transcribe.',
          });
          return;
        }

        const controller = new AbortController();
        requestAbortRef.current = controller;
        try {
          const metadata = recordingMetadata(recordingUri);
          voiceDebug('discovery-transcribe-upload-start', {
            apiRoot: process.env.EXPO_PUBLIC_API_URL || 'auto',
            recordedDurationMillis,
            mimeType: metadata.mimeType,
            name: metadata.name,
          });
          const result = await transcribeRecording(
            recordingUri,
            metadata,
            { signal: controller.signal },
          );
          if (
            controller.signal.aborted ||
            operationRef.current !== operation ||
            episodeRef.current
          ) {
            return;
          }
          utterance = result.transcript.trim();
          voiceDebug('discovery-transcribe-upload-success', {
            transcriptLength: utterance.length,
            provider: result.provider,
            model: result.model,
          });
        } catch (error) {
          if (
            controller.signal.aborted ||
            operationRef.current !== operation ||
            (error instanceof MurmurApiError && error.kind === 'cancelled')
          ) {
            return;
          }
          voiceDebug('discovery-transcribe-upload-failed', {
            message: error instanceof Error ? error.message : String(error),
            code: error instanceof MurmurApiError ? error.code : undefined,
            kind: error instanceof MurmurApiError ? error.kind : undefined,
          });
          updateDiscoveryVoice({
            phase: 'error',
            transcript: '',
            message: transcriptionFailureMessage(error),
          });
          return;
        } finally {
          if (requestAbortRef.current === controller) {
            requestAbortRef.current = undefined;
          }
        }
      }

      deleteVoiceRecording(recordingUri);
      recordingUri = undefined;
      if (operationRef.current !== operation || episodeRef.current) return;
      if (!utterance) {
        updateDiscoveryVoice({
          phase: 'error',
          transcript: '',
          message: 'I didn’t catch that. Try voice again.',
        });
        return;
      }

      updateDiscoveryVoice({
        phase: 'processing',
        transcript: utterance,
        message: 'Finding your episode…',
      });
      await waitForTranscriptReveal();
      if (operationRef.current !== operation || episodeRef.current) return;
      await resolveDiscoveryRequest({
        utterance,
        episodes,
        focusedEpisodeId,
        operation,
      });
    } finally {
      deleteVoiceRecording(recordingUri);
      finishVoiceStop();
      discoveryFinalizingRef.current = false;
    }
  }, [
    abortVoiceRequest,
    finishVoiceStop,
    recorderState.durationMillis,
    resolveDiscoveryRequest,
    startVoiceStop,
    stopRealtimeMicrophone,
    stopVoiceCapture,
    updateDiscoveryVoice,
  ]);

  useEffect(() => {
    discoveryFinalizeRef.current = finalizeDiscoveryVoice;
  }, [finalizeDiscoveryVoice]);

  const beginDiscoveryVoice = useCallback(async (
    episodes: readonly CatalogEpisode[],
    focusedEpisodeId?: string,
  ) => {
    if (episodeRef.current || episodes.length === 0) return;

    discoveryEpisodesRef.current = episodes;
    discoveryFocusedEpisodeIdRef.current = focusedEpisodeId;

    if (discoveryVoiceRef.current.phase === 'listening') {
      await discoveryFinalizeRef.current?.();
      return;
    }
    if (
      discoveryVoiceRef.current.phase === 'arming' ||
      discoveryVoiceRef.current.phase === 'processing' ||
      discoveryFinalizingRef.current ||
      voiceStopInFlightRef.current ||
      voiceStartOperationRef.current !== undefined
    ) {
      return;
    }

    const operation = operationRef.current + 1;
    operationRef.current = operation;
    voiceStartOperationRef.current = operation;
    browserTranscriptRef.current = '';
    abortVoiceRequest();
    updateDiscoveryVoice({
      phase: 'arming',
      transcript: '',
      message: 'Opening microphone…',
    });
    pingNativeVoiceRoute('discovery');
    player.pause();
    await stopAssistant();
    await stopVoiceCapture();

    if (operationRef.current !== operation || episodeRef.current) {
      if (voiceStartOperationRef.current === operation) {
        voiceStartOperationRef.current = undefined;
      }
      return;
    }

    if (process.env.EXPO_PUBLIC_MURMUR_REALTIME_VOICE !== 'off') {
      await cancelRealtimeVoice();
      let finalHandled = false;
      const session = new RealtimeTranscriptionSession({
        onSpeechStarted: () => {
          if (operationRef.current !== operation || episodeRef.current) return;
          discoveryFinalizingRef.current = false;
          updateDiscoveryVoice({
            phase: 'listening',
            transcript: discoveryVoiceRef.current.transcript,
            message: undefined,
          });
        },
        onPartialTranscript: (nextTranscript) => {
          if (operationRef.current !== operation || episodeRef.current) return;
          browserTranscriptRef.current = nextTranscript;
          updateDiscoveryVoice({
            phase: 'listening',
            transcript: nextTranscript,
            message: undefined,
          });
        },
        onSpeechStopped: () => {
          if (operationRef.current !== operation || episodeRef.current) return;
          discoveryFinalizingRef.current = true;
          updateDiscoveryVoice({
            phase: 'processing',
            transcript: discoveryVoiceRef.current.transcript,
            message: 'Understanding…',
          });
          void stopRealtimeMicrophone();
        },
        onFinalTranscript: (finalTranscript) => {
          if (finalHandled) return;
          finalHandled = true;
          void (async () => {
            await stopRealtimeMicrophone();
            if (realtimeSessionRef.current === session) {
              session.cancel();
              realtimeSessionRef.current = undefined;
            }
            discoveryFinalizingRef.current = false;
            if (operationRef.current !== operation || episodeRef.current) return;

            const utterance = finalTranscript.trim();
            browserTranscriptRef.current = utterance;
            if (!utterance) {
              updateDiscoveryVoice({
                phase: 'error',
                transcript: '',
                message: 'I didn’t hear speech. Try voice again.',
              });
              return;
            }

            updateDiscoveryVoice({
              phase: 'processing',
              transcript: utterance,
              message: 'Finding your episode…',
            });
            await waitForTranscriptReveal();
            if (operationRef.current !== operation || episodeRef.current) return;
            await resolveDiscoveryRequest({
              utterance,
              episodes,
              focusedEpisodeId,
              operation,
            });
          })();
        },
        onError: (error) => {
          if (
            realtimeSessionRef.current !== session ||
            operationRef.current !== operation ||
            episodeRef.current
          ) return;
          voiceDebug('discovery-realtime-failed', {
            code: error instanceof RealtimeVoiceError ? error.code : undefined,
            message: error.message,
          });
          discoveryFinalizingRef.current = false;
          void cancelRealtimeVoice();
          updateDiscoveryVoice({
            phase: 'error',
            transcript: discoveryVoiceRef.current.transcript,
            message: 'Live voice lost its connection. Try again.',
          });
        },
      });
      realtimeSessionRef.current = session;

      try {
        assertWebPcmCaptureAvailable();
        await session.connect('discovery');
        if (operationRef.current !== operation || episodeRef.current) {
          await cancelRealtimeVoice();
          return;
        }
        await startRealtimeMicrophone(session, () => {
          void discoveryFinalizeRef.current?.();
        });
        if (operationRef.current !== operation || episodeRef.current) {
          await cancelRealtimeVoice();
          return;
        }
        updateDiscoveryVoice({
          phase: 'listening',
          transcript: '',
          message: undefined,
        });
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
      } catch (error) {
        await cancelRealtimeVoice();
        if (operationRef.current !== operation || episodeRef.current) return;
        voiceDebug('discovery-realtime-start-failed', {
          code: error instanceof RealtimeVoiceError ? error.code : undefined,
          message: error instanceof Error ? error.message : String(error),
        });
        updateDiscoveryVoice({
          phase: 'error',
          transcript: '',
          message: realtimeVoiceFailureMessage(error),
        });
      } finally {
        if (voiceStartOperationRef.current === operation) {
          voiceStartOperationRef.current = undefined;
        }
      }
      return;
    }

    if (process.env.EXPO_OS === 'web') {
      const availableCaptureCapabilities = webVoiceCaptureCapabilities();
      const captureCapabilities = {
        ...availableCaptureCapabilities,
        liveTranscription:
          availableCaptureCapabilities.liveTranscription &&
          !browserRecognitionUnavailableRef.current,
      };
      const captureStrategy = resolveWebVoiceCaptureStrategy(captureCapabilities);
      let startedRecording = false;
      updateDiscoveryVoice({
        phase: 'listening',
        transcript: '',
        message: 'Listening…',
      });
      const startedTranscription = captureStrategy === 'browser-transcription'
        ? startBrowserTranscription({
            onTranscript: (nextTranscript) => {
              const current = discoveryVoiceRef.current;
              const activeCapture =
                operationRef.current === operation && current.phase === 'listening';
              const finishingCapture =
                discoveryFinalizingRef.current && current.phase === 'processing';
              if (episodeRef.current || (!activeCapture && !finishingCapture)) return;
              updateDiscoveryVoice({
                ...current,
                transcript: nextTranscript,
              });
            },
            onError: (reason) => {
              if (
                operationRef.current === operation &&
                !episodeRef.current &&
                discoveryVoiceRef.current.phase === 'listening'
              ) {
                if (reason !== 'no-speech') {
                  browserRecognitionUnavailableRef.current = true;
                }
                void stopVoiceCapture();
                updateDiscoveryVoice({
                  phase: 'error',
                  transcript: '',
                  message: browserSpeechFailureMessage(reason),
                });
              }
            },
            onEnd: () => {
              if (
                operationRef.current === operation &&
                !episodeRef.current &&
                discoveryVoiceRef.current.phase === 'listening'
              ) {
                void discoveryFinalizeRef.current?.();
              }
            },
          })
        : false;

      // Use a recording upload only when live browser transcription is absent
      // or failed to start; never compete for the microphone with both paths.
      if (!startedTranscription && captureCapabilities.recordingUpload) {
        const readiness = await transcriptionReadiness();
        if (operationRef.current !== operation || episodeRef.current) {
          voiceStartOperationRef.current = undefined;
          return;
        }
        if (readiness !== 'ready') {
          updateDiscoveryVoice({
            phase: 'error',
            transcript: '',
            message:
              readiness === 'unconfigured'
                ? 'Voice transcription isn’t connected in this preview yet.'
                : 'The Murmur voice service can’t be reached. Check the connection and try again.',
          });
          voiceStartOperationRef.current = undefined;
          return;
        }
        try {
          await setAudioModeAsync(RECORDING_AUDIO_MODE);
          await recorder.prepareToRecordAsync();
          recorder.record();
          recordingActiveRef.current = true;
          captureActiveRecordingUri();
          resetNativeSilenceDetection();
          recordingBeganAtRef.current = Date.now();
          recordingFinalizeRef.current = () => {
            void discoveryFinalizeRef.current?.();
          };
          if (recordingLimitTimerRef.current) clearTimeout(recordingLimitTimerRef.current);
          recordingLimitTimerRef.current = setTimeout(() => {
            recordingFinalizeRef.current?.();
          }, NATIVE_RECORDING_AUTO_FINALIZE_MS);
          startedRecording = true;
        } catch {
          recordingActiveRef.current = false;
          recordingBeganAtRef.current = 0;
          recordingFinalizeRef.current = undefined;
          if (recordingLimitTimerRef.current) clearTimeout(recordingLimitTimerRef.current);
          recordingLimitTimerRef.current = undefined;
        }
      }

      if (operationRef.current !== operation || episodeRef.current) {
        if (startedRecording || startedTranscription) await stopVoiceCapture();
        if (voiceStartOperationRef.current === operation) {
          voiceStartOperationRef.current = undefined;
        }
        return;
      }

      voiceStartOperationRef.current = undefined;
      if (
        !startedTranscription &&
        !startedRecording &&
        operationRef.current === operation &&
        !episodeRef.current
      ) {
        updateDiscoveryVoice({
          phase: 'error',
          transcript: '',
          message:
            captureStrategy === 'unavailable'
              ? 'This preview browser does not expose microphone capture. Open Murmur in Chrome, Safari, or Expo Go.'
              : 'Voice capture could not start in this browser. Check microphone access and try again.',
        });
      } else if (!startedTranscription && startedRecording) {
        updateDiscoveryVoice({
          phase: 'listening',
          transcript: '',
          message: 'Tap again when you’re done.',
        });
      }
      return;
    }

    try {
      const permission = await requestRecordingPermissionsAsync();
      if (operationRef.current !== operation || episodeRef.current) return;
      if (!permission.granted) {
        updateDiscoveryVoice({
          phase: 'error',
          transcript: '',
          message: 'Microphone access is off.',
        });
        return;
      }

      await setAudioModeAsync(RECORDING_AUDIO_MODE);
      if (operationRef.current !== operation || episodeRef.current) {
        await stopVoiceCapture();
        return;
      }
      const startedNativePcm = await startNativePcmCapture(() => {
        void discoveryFinalizeRef.current?.();
      });
      if (operationRef.current !== operation || episodeRef.current) {
        await stopVoiceCapture();
        return;
      }
      if (startedNativePcm) {
        updateDiscoveryVoice({
          phase: 'listening',
          transcript: '',
          message: undefined,
        });
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
        return;
      }

      voiceDebug('discovery-native-pcm-fallback-to-recorder');
      await recorder.prepareToRecordAsync();
      if (!mountedRef.current) return;
      nativeRecorderPreparedRef.current = true;
      captureActiveRecordingUri();
      if (operationRef.current !== operation || episodeRef.current) {
        await stopVoiceCapture();
        return;
      }
      recorder.record();
      recordingActiveRef.current = true;
      captureActiveRecordingUri();
      resetNativeSilenceDetection();
      recordingBeganAtRef.current = Date.now();
      recordingFinalizeRef.current = () => {
        void discoveryFinalizeRef.current?.();
      };
      if (recordingLimitTimerRef.current) clearTimeout(recordingLimitTimerRef.current);
      recordingLimitTimerRef.current = setTimeout(() => {
        recordingFinalizeRef.current?.();
      }, NATIVE_RECORDING_AUTO_FINALIZE_MS);
      updateDiscoveryVoice({
        phase: 'listening',
        transcript: '',
        message: undefined,
      });
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    } catch {
      await stopVoiceCapture();
      if (operationRef.current !== operation || episodeRef.current) return;
      updateDiscoveryVoice({
        phase: 'error',
        transcript: '',
        message: 'Couldn’t start the microphone.',
      });
    } finally {
      if (voiceStartOperationRef.current === operation) {
        voiceStartOperationRef.current = undefined;
      }
    }
  }, [
    abortVoiceRequest,
    cancelRealtimeVoice,
    captureActiveRecordingUri,
    pingNativeVoiceRoute,
    player,
    recorder,
    resetNativeSilenceDetection,
    resolveDiscoveryRequest,
    startNativePcmCapture,
    startRealtimeMicrophone,
    startBrowserTranscription,
    stopAssistant,
    stopVoiceCapture,
    stopRealtimeMicrophone,
    transcriptionReadiness,
    updateDiscoveryVoice,
  ]);

  const cancelDiscoveryVoice = useCallback(async () => {
    if (discoveryVoiceRef.current.phase === 'idle' && !discoveryFinalizingRef.current) return;

    operationRef.current += 1;
    voiceStartOperationRef.current = undefined;
    discoveryEpisodesRef.current = [];
    discoveryFocusedEpisodeIdRef.current = undefined;
    browserTranscriptRef.current = '';
    abortVoiceRequest();
    updateDiscoveryVoice(IDLE_DISCOVERY_VOICE);

    if (startVoiceStop()) {
      try {
        await stopVoiceCapture();
        await stopAssistant();
      } finally {
        finishVoiceStop();
      }
    }
  }, [abortVoiceRequest, finishVoiceStop, startVoiceStop, stopAssistant, stopVoiceCapture, updateDiscoveryVoice]);

  const handleSkipAd = useCallback(async () => {
    const activeEpisode = episodeRef.current;
    if (!activeEpisode) return;

    const operation = operationRef.current + 1;
    operationRef.current = operation;
    voiceStartOperationRef.current = undefined;
    abortVoiceRequest();
    await stopAssistant();
    if (operationRef.current !== operation) return;
    const currentSeconds = player.currentTime;
    const wasPlaying = player.playing;

    const resolution = resolveVerifiedAdSegment({
      assetIdentityKind: activeEpisode.audioAsset.identityKind,
      assetVersionId: activeEpisode.audioAsset.versionId,
      currentSeconds,
      segments: activeEpisode.adSegments,
    });

    if (resolution.kind === 'resolved') {
      try {
        player.pause();
        await player.seekTo(resolution.seekToSeconds);
        if (
          operationRef.current !== operation ||
          episodeRef.current?.id !== activeEpisode.id
        ) {
          return;
        }
        player.play();
        voiceSessionPreparedRef.current = false;
        setPlaybackIssue(undefined);
        setMode('playback');
        showNotice(`Ad skipped · resumed at ${formatDuration(resolution.seekToSeconds)}`);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      } catch {
        if (operationRef.current !== operation) return;
        await player.seekTo(currentSeconds).catch(() => undefined);
        if (operationRef.current !== operation) return;
        returnAnchorRef.current = currentSeconds;
        if (mode === 'playback') resumeAfterVoiceRef.current = wasPlaying;
        voiceSessionPreparedRef.current = true;
        setResponse('I could not complete that seek, so I kept the episode at the original moment.');
        setResponseCategory(undefined);
        setResponseProvider(undefined);
        setActivityMessage(undefined);
        setMode('error');
      }
      return;
    }

    returnAnchorRef.current = currentSeconds;
    if (mode === 'playback') resumeAfterVoiceRef.current = wasPlaying;
    voiceSessionPreparedRef.current = true;
    player.pause();
    setResponse(
      'I cannot verify an ad boundary at this moment, so I left the episode exactly where it was.',
    );
    setResponseCategory(undefined);
    setResponseProvider(undefined);
    setActivityMessage(undefined);
    setMode('error');
  }, [abortVoiceRequest, mode, player, showNotice, stopAssistant]);

  const submitVoiceIntent = useCallback(
    async (utterance: string) => {
      const activeEpisode = episodeRef.current;
      let cleaned = utterance.trim();
      if (!activeEpisode || !cleaned) return;

      const browserDraft = browserTranscriptRef.current.trim();
      const finalizeBrowserVoice =
        process.env.EXPO_OS === 'web' &&
        recognitionRef.current !== undefined &&
        browserDraft.length > 0 &&
        cleaned === browserDraft;

      const operation = operationRef.current + 1;
      operationRef.current = operation;
      voiceStartOperationRef.current = undefined;
      abortVoiceRequest();
      await stopVoiceCapture(false, finalizeBrowserVoice);
      if (
        operationRef.current !== operation ||
        episodeRef.current?.id !== activeEpisode.id
      ) {
        return;
      }
      if (finalizeBrowserVoice && browserTranscriptRef.current.trim()) {
        cleaned = browserTranscriptRef.current.trim();
      }
      await stopAssistant();
      if (operationRef.current !== operation) return;
      setTranscriptText(cleaned);
      setActivityMessage(undefined);
      const intent = routeVoiceIntent(cleaned);

      if (intent.kind === 'command') {
        if (intent.command === 'skip-ad') {
          await handleSkipAd();
          return;
        }

        if (intent.command === 'pause') {
          player.pause();
          voiceSessionPreparedRef.current = false;
          setMode('playback');
          showNotice('Paused');
          return;
        }

        if (intent.command === 'play') {
          player.play();
          voiceSessionPreparedRef.current = false;
          setMode('playback');
          showNotice('Playing');
          return;
        }

        if (intent.command !== 'seek-relative') return;

        const target = clampPosition(
          player.currentTime + intent.deltaSeconds,
          player.duration,
        );
        try {
          await player.seekTo(target);
        } catch {
          if (operationRef.current !== operation) return;
          setResponse('I could not move playback to that moment, so the episode remains paused.');
          setResponseCategory(undefined);
          setResponseProvider(undefined);
          setActivityMessage(undefined);
          setMode('error');
          return;
        }
        if (operationRef.current !== operation) return;
        player.play();
        voiceSessionPreparedRef.current = false;
        setMode('playback');
        showNotice(
          `${intent.deltaSeconds < 0 ? 'Back' : 'Forward'} ${Math.abs(intent.deltaSeconds)} seconds`,
        );
        return;
      }

      if (intent.kind === 'unknown') {
        setResponse('I could not tell whether that was an action or a question. Try asking it another way.');
        setResponseCategory(undefined);
        setResponseProvider(undefined);
        setActivityMessage(undefined);
        setMode('error');
        return;
      }

      setMode('processing');
      setResponseCategory(intent.category);
      setResponseProvider(undefined);
      setActivityMessage('Following the episode context…');
      const availableTranscript = transcriptRef.current.length
        ? transcriptRef.current
        : await loadTranscript(activeEpisode);
      if (
        operationRef.current !== operation ||
        episodeRef.current?.id !== activeEpisode.id
      ) {
        return;
      }
      const controller = new AbortController();
      requestAbortRef.current = controller;
      let answer: string;
      let answerProvider: 'local' | 'openai';

      try {
        const remoteAnswer = await exploreTurn(
          {
            question: cleaned,
            intent: intent.category,
            episode: {
              title: activeEpisode.title,
              showTitle: activeEpisode.podcastTitle,
            },
            playbackPositionSeconds: returnAnchorRef.current,
            transcriptContext: availableTranscript.length > 0
              ? buildTranscriptContext(
                  availableTranscript,
                  returnAnchorRef.current,
                )
              : buildEpisodeMetadataContext(
                  activeEpisode,
                  returnAnchorRef.current,
                ),
            history: turns.map(({ question, answer: priorAnswer }) => ({
              question,
              answer: priorAnswer,
            })),
          },
          { signal: controller.signal },
        );
        answer = remoteAnswer.answer;
        answerProvider = 'openai';
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error instanceof MurmurApiError && error.kind === 'cancelled') ||
          operationRef.current !== operation
        ) {
          return;
        }

        if (!(error instanceof MurmurApiError) || !error.fallbackEligible) {
          if (requestAbortRef.current === controller) {
            requestAbortRef.current = undefined;
          }
          setResponse(
            'I could not safely process that request. Rephrase it or return to the episode.',
          );
          setResponseCategory(undefined);
          setResponseProvider(undefined);
          setActivityMessage(undefined);
          setMode('error');
          return;
        }

        answer = buildContextualAnswer({
          category: intent.category,
          episode: activeEpisode,
          positionSeconds: returnAnchorRef.current,
          priorTurns: turns,
          transcript: availableTranscript,
          utterance: cleaned,
        });
        answerProvider = 'local';
        showNotice('Using the local context preview');
      }

      if (
        operationRef.current !== operation ||
        episodeRef.current?.id !== activeEpisode.id ||
        controller.signal.aborted
      ) {
        return;
      }

      setResponse(answer);
      setResponseProvider(answerProvider);
      setActivityMessage(undefined);
      setTurns((currentTurns) => [
        ...currentTurns,
        {
          id: `${Date.now()}-${currentTurns.length}`,
          question: cleaned,
          answer,
          category: intent.category,
        },
      ].slice(-5));
      setMode('speaking');
      if (operationRef.current !== operation) return;
      await speakAssistant(answer, {
        signal: controller.signal,
        onDone: () => {
          if (
            operationRef.current === operation &&
            episodeRef.current?.id === activeEpisode.id
          ) {
            if (requestAbortRef.current === controller) {
              requestAbortRef.current = undefined;
            }
            setMode('exploring');
          }
        },
      }).catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          operationRef.current !== operation ||
          episodeRef.current?.id !== activeEpisode.id ||
          (error instanceof MurmurApiError && error.kind === 'cancelled')
        ) return;

        if (requestAbortRef.current === controller) {
          requestAbortRef.current = undefined;
        }
        setMode('exploring');
      });
    },
    [
      abortVoiceRequest,
      handleSkipAd,
      loadTranscript,
      player,
      showNotice,
      speakAssistant,
      stopAssistant,
      stopVoiceCapture,
      turns,
    ],
  );

  useEffect(() => {
    submitIntentRef.current = submitVoiceIntent;
  }, [submitVoiceIntent]);

  const cancelVoice = useCallback(async () => {
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    voiceStartOperationRef.current = undefined;
    const activeEpisodeId = episodeRef.current?.id;
    const returnAnchor = returnAnchorRef.current;
    const resumeAfterVoice = resumeAfterVoiceRef.current;
    voiceSessionPreparedRef.current = false;
    abortVoiceRequest();
    await stopWakeWordMonitoring();

    await waitForVoiceStop();
    if (operationRef.current !== operation || episodeRef.current?.id !== activeEpisodeId) return;

    if (!startVoiceStop()) return;
    try {
      await stopVoiceCapture();
      await stopAssistant();
    } finally {
      finishVoiceStop();
    }
    if (
      operationRef.current !== operation ||
      episodeRef.current?.id !== activeEpisodeId
    ) {
      return;
    }
    try {
      await player.seekTo(returnAnchor);
    } catch {
      setResponse('I could not restore that timestamp. Playback remains paused.');
      setResponseCategory(undefined);
      setResponseProvider(undefined);
      setActivityMessage(undefined);
      setMode('error');
      return;
    }
    if (operationRef.current !== operation) return;
    setResponse(undefined);
    setResponseCategory(undefined);
    setResponseProvider(undefined);
    setActivityMessage(undefined);
    setTranscriptText('');
    setMode('playback');
    if (resumeAfterVoice) player.play();
  }, [
    abortVoiceRequest,
    finishVoiceStop,
    player,
    startVoiceStop,
    stopAssistant,
    stopVoiceCapture,
    stopWakeWordMonitoring,
    waitForVoiceStop,
  ]);

  const returnToEpisode = useCallback(async () => {
    if (!startVoiceStop()) return;
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    voiceStartOperationRef.current = undefined;
    const activeEpisodeId = episodeRef.current?.id;
    const returnAnchor = returnAnchorRef.current;
    voiceSessionPreparedRef.current = false;
    abortVoiceRequest();
    try {
      await stopVoiceCapture();
      await stopAssistant();
    } finally {
      finishVoiceStop();
    }
    if (
      operationRef.current !== operation ||
      episodeRef.current?.id !== activeEpisodeId
    ) {
      return;
    }
    try {
      await player.seekTo(returnAnchor);
    } catch {
      setResponse('I could not restore that timestamp. Playback remains paused.');
      setResponseCategory(undefined);
      setResponseProvider(undefined);
      setActivityMessage(undefined);
      setMode('error');
      return;
    }
    if (operationRef.current !== operation) return;
    setResponse(undefined);
    setResponseCategory(undefined);
    setResponseProvider(undefined);
    setActivityMessage(undefined);
    setTranscriptText('');
    setMode('playback');
    player.play();
    showNotice('Back to the episode');
  }, [
    abortVoiceRequest,
    finishVoiceStop,
    player,
    showNotice,
    startVoiceStop,
    stopAssistant,
    stopVoiceCapture,
  ]);

  const retryPlayback = useCallback(async (): Promise<void> => {
    const activeEpisode = episodeRef.current;
    const issue = playbackIssue;
    if (!started || !activeEpisode || !issue) return;

    const operation = operationRef.current + 1;
    operationRef.current = operation;
    voiceStartOperationRef.current = undefined;
    voiceSessionPreparedRef.current = false;
    abortVoiceRequest();

    await waitForVoiceStop();
    if (
      operationRef.current !== operation ||
      episodeRef.current?.id !== activeEpisode.id
    ) {
      return;
    }
    if (!startVoiceStop()) return;

    try {
      await stopVoiceCapture();
      await stopAssistant();
    } finally {
      finishVoiceStop();
    }
    if (
      operationRef.current !== operation ||
      episodeRef.current?.id !== activeEpisode.id
    ) {
      return;
    }

    setResponse(undefined);
    setResponseCategory(undefined);
    setResponseProvider(undefined);
    setActivityMessage(undefined);
    setTranscriptText('');
    setPlaybackIssue(undefined);
    setMode('loading');

    const currentTime = Number.isFinite(player.currentTime) ? player.currentTime : 0;
    const duration = player.duration || activeEpisode.durationSeconds || 0;
    const retryPosition = clampPosition(currentTime, duration);
    const playbackRate = playerStatus.playbackRate || 1;

    try {
      await setAudioModeAsync(PLAYBACK_AUDIO_MODE);
      player.pause();
      if (issue === 'error') {
        player.replace(
          activeEpisode.audioAsset.bundledSource ?? {
            uri: activeEpisode.audioAsset.url,
            name: activeEpisode.title,
          },
        );
        if (retryPosition > 0) await player.seekTo(retryPosition);
      } else {
        await player.seekTo(0);
      }
      if (
        operationRef.current !== operation ||
        episodeRef.current?.id !== activeEpisode.id
      ) {
        return;
      }
      player.setPlaybackRate(playbackRate, 'high');
      player.play();
      setPlaybackIssue(undefined);
      setMode('playback');
      showNotice(issue === 'error' ? 'Playback restarted' : 'Replaying from the beginning');
    } catch {
      if (
        operationRef.current !== operation ||
        episodeRef.current?.id !== activeEpisode.id
      ) {
        return;
      }
      player.pause();
      setPlaybackIssue('error');
      setMode('playback');
      showNotice('Playback is still unavailable');
    }
  }, [
    abortVoiceRequest,
    finishVoiceStop,
    playbackIssue,
    player,
    playerStatus.playbackRate,
    showNotice,
    startVoiceStop,
    started,
    stopAssistant,
    stopVoiceCapture,
    waitForVoiceStop,
  ]);

  const leaveListening = useCallback(async () => {
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    voiceStartOperationRef.current = undefined;
    voiceSessionPreparedRef.current = false;
    abortVoiceRequest();
    await stopWakeWordMonitoring();

    await waitForVoiceStop();
    if (operationRef.current !== operation || !startVoiceStop()) return;
    try {
      await stopVoiceCapture();
      await stopAssistant();
    } finally {
      finishVoiceStop();
    }
    if (operationRef.current !== operation) return;
    player.pause();
    episodeRef.current = undefined;
    transcriptRef.current = [];
    transcriptRequestRef.current += 1;
    setEpisode(undefined);
    setStarted(false);
    setPlaybackIssue(undefined);
    setMode('idle');
    setTranscript([]);
    setTranscriptStatus('loading');
    setTranscriptText('');
    setResponse(undefined);
    setResponseCategory(undefined);
    setResponseProvider(undefined);
    setActivityMessage(undefined);
    setTurns([]);
  }, [
    abortVoiceRequest,
    finishVoiceStop,
    player,
    startVoiceStop,
    stopAssistant,
    stopVoiceCapture,
    stopWakeWordMonitoring,
    waitForVoiceStop,
  ]);

  const activeAdResolution = episode
    ? resolveVerifiedAdSegment({
        assetIdentityKind: episode.audioAsset.identityKind,
        assetVersionId: episode.audioAsset.versionId,
        currentSeconds: playerStatus.currentTime,
        segments: episode.adSegments,
      })
    : undefined;
  const activeAd = activeAdResolution?.kind === 'resolved';
  const recordingMetering = normalizeRecordingMetering(
    recorderState.metering,
    recorderState.isRecording,
  ) ?? nativePcmMetering;

  return {
    episode,
    started,
    mode,
    currentTime: playerStatus.currentTime,
    duration: playerStatus.duration,
    playing: playerStatus.playing,
    buffering: started && (!playerStatus.isLoaded || playerStatus.isBuffering),
    playbackRate: playerStatus.playbackRate || 1,
    transcript,
    transcriptStatus,
    transcriptText,
    response,
    responseCategory,
    responseProvider,
    activityMessage,
    turns,
    notice,
    playbackIssue,
    discoveryVoice,
    wakeWordStatus,
    wakeWordActivation,
    recordingDurationMillis: Math.max(recorderState.durationMillis, nativePcmDurationMillis),
    recordingMetering,
    adSkipAvailable: activeAd,
    activeAdEndSeconds: activeAd ? activeAdResolution.seekToSeconds : undefined,
    setTranscriptText,
    startEpisode,
    togglePlayback,
    seekTo,
    seekBy,
    cyclePlaybackRate,
    prepareVoice,
    beginDiscoveryVoice,
    cancelDiscoveryVoice,
    beginVoice,
    submitVoiceIntent,
    handleSkipAd,
    cancelVoice,
    returnToEpisode,
    retryPlayback,
    leaveListening,
  };
}
