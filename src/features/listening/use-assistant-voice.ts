import {
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
  type AudioMode,
} from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import * as Speech from 'expo-speech';
import { useCallback, useEffect, useRef } from 'react';

import { PLAYBACK_AUDIO_MODE } from '@/features/listening/audio-mode';
import {
  MurmurApiError,
  synthesizeSpeech,
  type SynthesizedSpeech,
} from '@/services/api/murmur-api-client';

type AssistantVoiceOptions = {
  signal?: AbortSignal;
  onDone?: () => void;
  loadSpeech?: (signal?: AbortSignal) => Promise<SynthesizedSpeech>;
};

type PreparedAudio = {
  uri: string;
  cleanup: () => void;
};

type ActiveCompletion = {
  session: number;
  text: string;
  kind: 'device' | 'remote';
  started: boolean;
  onDone?: () => void;
};

function playbackWatchdogMilliseconds(text: string): number {
  return Math.min(180_000, Math.max(15_000, text.length * 85 + 5_000));
}

function prepareAudio(speech: SynthesizedSpeech): PreparedAudio {
  if (process.env.EXPO_OS === 'web') {
    const uri = URL.createObjectURL(new Blob([speech.audio], { type: speech.mimeType }));
    return { uri, cleanup: () => URL.revokeObjectURL(uri) };
  }

  const file = new File(Paths.cache, `murmur-assistant-${Date.now()}.mp3`);
  file.write(new Uint8Array(speech.audio));
  return {
    uri: file.uri,
    cleanup: () => {
      try {
        if (file.exists) file.delete();
      } catch {
        // Cache cleanup should never interrupt the listening handoff.
      }
    },
  };
}

export function useAssistantVoice({ audioMode = PLAYBACK_AUDIO_MODE, deviceAnnouncements = false }: { audioMode?: AudioMode; deviceAnnouncements?: boolean } = {}) {
  const player = useAudioPlayer(null, { updateInterval: 120 });
  const status = useAudioPlayerStatus(player);
  const sessionRef = useRef(0);
  const completionRef = useRef<ActiveCompletion | undefined>(undefined);
  const preparedAudioRef = useRef<{ session: number; audio: PreparedAudio } | undefined>(undefined);
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const startTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearWatchdog = useCallback(() => {
    if (watchdogTimerRef.current) clearTimeout(watchdogTimerRef.current);
    watchdogTimerRef.current = undefined;
  }, []);

  const clearStartTimer = useCallback(() => {
    if (startTimerRef.current) clearTimeout(startTimerRef.current);
    startTimerRef.current = undefined;
  }, []);

  const clearPreparedAudio = useCallback((session?: number) => {
    if (session !== undefined && preparedAudioRef.current?.session !== session) return;
    preparedAudioRef.current?.audio.cleanup();
    preparedAudioRef.current = undefined;
  }, []);

  const finish = useCallback(
    (session: number) => {
      const completion = completionRef.current;
      if (!completion || completion.session !== session || sessionRef.current !== session) return;

      completionRef.current = undefined;
      clearWatchdog();
      clearStartTimer();
      try {
        player.pause();
      } catch {
        // The player can already be released during navigation cleanup.
      }
      clearPreparedAudio(session);
      completion.onDone?.();
    },
    [clearPreparedAudio, clearStartTimer, clearWatchdog, player],
  );

  const stop = useCallback(async () => {
    sessionRef.current += 1;
    completionRef.current = undefined;
    clearWatchdog();
    clearStartTimer();
    try {
      player.pause();
    } catch {
      // The player can already be stopped or released.
    }
    clearPreparedAudio();
    await Speech.stop().catch(() => undefined);
  }, [clearPreparedAudio, clearStartTimer, clearWatchdog, player]);

  const startDeviceSpeech = useCallback(
    (session: number, text: string) => {
      const completion = completionRef.current;
      if (!completion || completion.session !== session || sessionRef.current !== session) return;

      completion.kind = 'device';
      completion.started = true;
      clearStartTimer();
      try {
        player.pause();
      } catch {
        // A failed generated-audio source should not block the device voice fallback.
      }
      clearPreparedAudio(session);
      clearWatchdog();
      watchdogTimerRef.current = setTimeout(() => {
        void Speech.stop()
          .catch(() => undefined)
          .then(() => finish(session));
      }, playbackWatchdogMilliseconds(text));

      try {
        Speech.speak(`Murmur. ${text}`, {
          useApplicationAudioSession: true,
          language: 'en-US',
          pitch: 0.92,
          rate: 0.94,
          onDone: () => finish(session),
          onStopped: () => finish(session),
          onError: () => finish(session),
        });
      } catch {
        finish(session);
      }
    },
    [clearPreparedAudio, clearStartTimer, clearWatchdog, finish, player],
  );

  useEffect(() => {
    const completion = completionRef.current;
    if (!completion || completion.kind !== 'remote') return;

    if (status.playing) {
      completion.started = true;
      clearStartTimer();
    }

    if (status.error) {
      startDeviceSpeech(completion.session, completion.text);
    } else if (status.didJustFinish && completion.started) {
      finish(completion.session);
    }
  }, [clearStartTimer, finish, startDeviceSpeech, status.didJustFinish, status.error, status.playing]);

  useEffect(() => () => {
    sessionRef.current += 1;
    completionRef.current = undefined;
    clearWatchdog();
    clearStartTimer();
    clearPreparedAudio();
    void Speech.stop().catch(() => undefined);
  }, [clearPreparedAudio, clearStartTimer, clearWatchdog]);

  const speak = useCallback(
    async (
      text: string,
      { signal, onDone, loadSpeech }: AssistantVoiceOptions = {},
    ): Promise<'device' | 'openai'> => {
      await stop();
      if (signal?.aborted) {
        throw new MurmurApiError('Assistant speech was cancelled.', {
          kind: 'cancelled',
          operation: 'speech',
          code: 'request_cancelled',
          retryable: false,
          fallbackEligible: false,
        });
      }

      const session = sessionRef.current + 1;
      sessionRef.current = session;

      if ((process.env.EXPO_OS !== 'web' || deviceAnnouncements) && !loadSpeech) {
        completionRef.current = {
          session,
          text,
          kind: 'device',
          started: true,
          onDone,
        };
        startDeviceSpeech(session, text);
        return 'device';
      }

      try {
        const speech = await (loadSpeech ? loadSpeech(signal) : synthesizeSpeech(`Murmur. ${text}`, { signal }));
        if (sessionRef.current !== session || signal?.aborted) {
          throw new MurmurApiError('Assistant speech was cancelled.', {
            kind: 'cancelled',
            operation: 'speech',
            code: 'request_cancelled',
            retryable: false,
            fallbackEligible: false,
          });
        }

        const prepared = prepareAudio(speech);
        preparedAudioRef.current = { session, audio: prepared };
        await setAudioModeAsync(audioMode).catch(() => undefined);
        if (sessionRef.current !== session || signal?.aborted) {
          prepared.cleanup();
          if (preparedAudioRef.current?.audio === prepared) preparedAudioRef.current = undefined;
          throw new MurmurApiError('Assistant speech was cancelled.', {
            kind: 'cancelled',
            operation: 'speech',
            code: 'request_cancelled',
            retryable: false,
            fallbackEligible: false,
          });
        }

        player.replace({ uri: prepared.uri, name: 'Murmur AI response' });
        completionRef.current = {
          session,
          text,
          kind: 'remote',
          started: false,
          onDone,
        };
        clearWatchdog();
        watchdogTimerRef.current = setTimeout(
          () => finish(session),
          playbackWatchdogMilliseconds(text),
        );
        clearStartTimer();
        startTimerRef.current = setTimeout(
          () => {
            const completion = completionRef.current;
            if (
              completion?.session === session &&
              completion.kind === 'remote' &&
              !completion.started
            ) {
              startDeviceSpeech(session, text);
            }
          },
          process.env.EXPO_OS === 'web' ? 1_800 : 3_500,
        );
        player.play();
        return 'openai';
      } catch (error) {
        if (
          signal?.aborted ||
          (error instanceof MurmurApiError && error.kind === 'cancelled') ||
          sessionRef.current !== session
        ) {
          if (completionRef.current?.session === session) {
            completionRef.current = undefined;
            clearStartTimer();
            clearWatchdog();
          }
          clearPreparedAudio(session);
          throw error;
        }

        completionRef.current = {
          session,
          text,
          kind: 'device',
          started: true,
          onDone,
        };
        startDeviceSpeech(session, text);
        return 'device';
      }
    },
    [
      clearPreparedAudio,
      clearStartTimer,
      clearWatchdog,
      finish,
      player,
      startDeviceSpeech,
      stop,
      audioMode,
      deviceAnnouncements,
    ],
  );

  return { speak, stop };
}
