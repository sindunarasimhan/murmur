import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus, useAudioStream } from 'expo-audio';
import * as Crypto from 'expo-crypto';
import { listeningApi, listeningBaseUrl, voiceGatewayUrl } from '@/services/api/listening-client';
import { ContinuousTranscription } from '@/services/voice/continuous-transcription';
import { startWebPcmCapture, type WebPcmCapture } from '@/services/voice/web-pcm-capture';
import { PLAYBACK_AUDIO_MODE, RECORDING_AUDIO_MODE } from '@/features/listening/audio-mode';
import { useAssistantVoice } from '@/features/listening/use-assistant-voice';
import { LennyVoiceController, type VoiceState } from './voice-controller';
import type { PreparedEpisode } from '../../../shared/listening';

const initial: VoiceState = { phase: 'idle', microphone: false, caption: 'A good conversation starts with listening.', heard: '' };
const Context = createContext<{ state: VoiceState; activate(): void; seconds: number; count: number; featured?: PreparedEpisode } | null>(null);

export function LennyVoiceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(initial);
  const [count, setCount] = useState(0);
  const [featured, setFeatured] = useState<PreparedEpisode>();
  const player = useAudioPlayer(null, { updateInterval: 200 });
  const status = useAudioPlayerStatus(player);
  const speech = useAssistantVoice({ audioMode: RECORDING_AUDIO_MODE, deviceAnnouncements: true });
  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);
  const controller = useRef<LennyVoiceController | undefined>(undefined);
  const transcriber = useRef<ContinuousTranscription | undefined>(undefined);
  const capture = useRef<WebPcmCapture | undefined>(undefined);
  const captureGeneration = useRef(0);
  const onBuffer = useCallback((chunk: { data: ArrayBuffer; sampleRate: number; channels: number }) => {
    transcriber.current?.append(chunk.data, chunk.sampleRate, chunk.channels);
  }, []);
  const { stream } = useAudioStream({ encoding: 'int16', sampleRate: 24_000, channels: 1, onBuffer });
  const latest = useRef({ speech, stream });
  useEffect(() => { latest.current = { speech, stream }; }, [speech, stream]);

  useEffect(() => {
    let alive = true;
    const instance = new LennyVoiceController({
      uuid: Crypto.randomUUID,
      api: listeningApi,
      changed: (next) => { if (alive) setState(next); },
      audio: {
        position: () => Number.isFinite(player.currentTime) ? player.currentTime : 0,
        load: async (episode, position, signal) => {
          if (!episode.audioPath) throw new Error('That episode’s audio is unavailable.');
          const uri = episode.audioPath.startsWith('https://') ? episode.audioPath : `${listeningBaseUrl()}${episode.audioPath}`;
          player.replace({ uri, name: episode.title });
          const started = Date.now();
          // Check the native player's source after replace; React status can still
          // describe the previous episode until the next render.
          while (!player.isLoaded) {
            signal.throwIfAborted();
            if (statusRef.current.error) throw new Error('That episode could not be played. Try another guest.');
            if (Date.now() - started > 20_000) throw new Error('The episode took too long to load. Your place is saved.');
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          signal.throwIfAborted();
          await player.seekTo(position, 0, 0);
        },
        play: () => { player.play(); }, pause: () => { player.pause(); },
        seek: async (seconds) => { await player.seekTo(seconds, 0, 0); return player.currentTime; },
        clear: () => { player.replace(null); },
      },
      microphone: {
        async start() {
          const generation = ++captureGeneration.current;
          if (process.env.EXPO_OS !== 'web') {
            const permission = await requestRecordingPermissionsAsync();
            if (generation !== captureGeneration.current) return;
            if (!permission.granted) throw new Error('Allow microphone access in iPhone Settings, then tap Hey Murmur.');
          } else {
            // Obtain capture before opening a paid upstream connection. A late
            // permission response after cancellation must immediately release it.
            const web = await startWebPcmCapture(onBuffer);
            if (generation !== captureGeneration.current) { await web.stop(); return; }
            capture.current = web;
          }
          const live = new ContinuousTranscription({
            url: () => voiceGatewayUrl().replace(/\/voice$/, '/live-voice'), ticket: (signal) => listeningApi.liveTicket(signal),
            callbacks: { partial: (text, id) => instance.partial(text, id), final: (text, id) => instance.final(text, id),
              activity: () => instance.activity(), error: (error) => { void instance.fail(error); } },
          });
          transcriber.current = live;
          await live.start();
          if (generation !== captureGeneration.current) { live.stop(); return; }
          if (process.env.EXPO_OS !== 'web') {
            await latest.current.stream.start();
            if (generation !== captureGeneration.current) { latest.current.stream.stop(); return; }
            // Expo's stream starts in record-only mode. Restore play-and-record
            // afterward so the podcast remains audible while the mic is open.
            await setAudioModeAsync(RECORDING_AUDIO_MODE);
          }
        },
        async stop() {
          captureGeneration.current++;
          transcriber.current?.stop(); transcriber.current = undefined;
          const web = capture.current; capture.current = undefined;
          await web?.stop().catch(() => undefined);
          if (process.env.EXPO_OS !== 'web') { try { latest.current.stream.stop(); } catch { /* Already released. */ } }
          await setAudioModeAsync(PLAYBACK_AUDIO_MODE).catch(() => undefined);
        },
      },
      speech: {
        stop: () => latest.current.speech.stop(),
        say: (text, signal, turn) => new Promise<void>((resolve, reject) => {
          const abort = () => { signal.removeEventListener('abort', abort); reject(new Error('Speech cancelled')); };
          if (signal.aborted) return abort();
          signal.addEventListener('abort', abort, { once: true });
          void latest.current.speech.speak(text, { signal,
            loadSpeech: turn ? (audioSignal) => listeningApi.speech(turn.session.id, turn.requestId, audioSignal) : undefined,
            onDone: () => { signal.removeEventListener('abort', abort); resolve(); },
          }).catch((error) => { signal.removeEventListener('abort', abort); reject(error); });
        }),
      },
    });
    controller.current = instance;
    const foreground = AppState.addEventListener('change', (next) => { if (next === 'background') void instance.shutdown(); });
    const progress = setInterval(() => { void instance.progress(); }, 10_000);
    const fetchController = new AbortController();
    void listeningApi.catalog(fetchController.signal).then((episodes) => { if (alive) { setCount(episodes.length); setFeatured(episodes.length === 1 ? episodes[0] : undefined); } }).catch(() => undefined);
    return () => { alive = false; fetchController.abort(); foreground.remove(); clearInterval(progress); void instance.dispose(); };
  }, [onBuffer, player]);
  useEffect(() => { if (status.didJustFinish) void controller.current?.ended(); }, [status.didJustFinish]);
  useEffect(() => {
    if (status.error && state.episode) void controller.current?.fail(new Error('The podcast audio stopped unexpectedly. Your place is saved.'));
  }, [state.episode, status.error]);
  return <Context.Provider value={{ state, seconds: status.currentTime, count, featured, activate: () => { void controller.current?.activate(); } }}>{children}</Context.Provider>;
}
export function useLennyVoice() {
  const value = useContext(Context);
  if (!value) throw new Error('LennyVoiceProvider is missing');
  return value;
}
