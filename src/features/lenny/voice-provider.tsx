import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';
import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus, useAudioStream } from 'expo-audio';
import * as Crypto from 'expo-crypto';
import { listeningApi, listeningBaseUrl, voiceGatewayUrl } from '@/services/api/listening-client';
import { ContinuousTranscription } from '@/services/voice/continuous-transcription';
import { startWebPcmCapture, type WebPcmCapture } from '@/services/voice/web-pcm-capture';
import { PLAYBACK_AUDIO_MODE, RECORDING_AUDIO_MODE } from '@/features/listening/audio-mode';
import { useAssistantVoice } from '@/features/listening/use-assistant-voice';
import { LennyVoiceController, wakeRequest, type VoiceState } from './voice-controller';
import { ForegroundVoice } from './foreground-voice';
import { NativeVoiceCapture } from './native-voice-capture';
import { loadEpisodeAudio } from './load-episode-audio';
import type { CaptionTrack, PreparedEpisode } from '../../../shared/listening';

const initial: VoiceState = { phase: 'idle', microphone: false, caption: 'A good conversation starts with listening.', heard: '' };
const Context = createContext<{ state: VoiceState; activate(): void; seconds: number; count: number; featured?: PreparedEpisode; captions: CaptionTrack['cues']; captionsError?: string } | null>(null);

export function LennyVoiceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(initial);
  const [count, setCount] = useState(0);
  const [featured, setFeatured] = useState<PreparedEpisode>();
  const [captionResult, setCaptionResult] = useState<{ key: string; cues: CaptionTrack['cues']; error?: string }>();
  const player = useAudioPlayer(null, { updateInterval: 200, keepAudioSessionActive: true });
  const status = useAudioPlayerStatus(player);
  const speech = useAssistantVoice({ audioMode: RECORDING_AUDIO_MODE, remoteOnly: true, keepAudioSessionActive: true, onLevel: (level) => controller.current?.speechEnergy(level) });
  const statusRef = useRef(status);
  useEffect(() => { statusRef.current = status; }, [status]);
  const controller = useRef<LennyVoiceController | undefined>(undefined);
  const transcriber = useRef<ContinuousTranscription | undefined>(undefined);
  const capture = useRef<WebPcmCapture | undefined>(undefined);
  const captureGeneration = useRef(0);
  const inputBuffers = useRef(0);
  const lastInputAt = useRef(0);
  const lastDiagnosticAt = useRef(0);
  const onBuffer = useCallback((chunk: { data: ArrayBuffer; sampleRate: number; channels: number }) => {
    if (chunk.data.byteLength > 0) { inputBuffers.current++; lastInputAt.current = Date.now(); }
    if (__DEV__ && Date.now() - lastDiagnosticAt.current > 10_000) {
      lastDiagnosticAt.current = Date.now();
      console.info('[murmur-voice] input', { buffers: inputBuffers.current, bytes: chunk.data.byteLength });
    }
    transcriber.current?.append(chunk.data, chunk.sampleRate, chunk.channels);
  }, []);
  const { stream } = useAudioStream({ encoding: 'int16', sampleRate: 24_000, channels: 1, onBuffer });
  const latest = useRef({ speech, stream });
  useEffect(() => { latest.current = { speech, stream }; }, [speech, stream]);
  const nativeCaptureRef = useRef<NativeVoiceCapture | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    let diagnosticPhase: VoiceState['phase'] | undefined;
    const nativeCapture = nativeCaptureRef.current ??= new NativeVoiceCapture({
      start: () => { inputBuffers.current = 0; return latest.current.stream.start(); },
      stop: () => { latest.current.stream.stop(); },
      recordingMode: () => setAudioModeAsync(RECORDING_AUDIO_MODE),
      playbackMode: () => setAudioModeAsync(PLAYBACK_AUDIO_MODE),
      inputReady: async () => {
        const deadline = Date.now() + 5000;
        while (inputBuffers.current === 0) {
          if (Date.now() >= deadline) throw new Error('The microphone opened but no audio arrived. Close other audio apps, then reopen Murmur.');
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      },
    });
    const instance = new LennyVoiceController({
      uuid: Crypto.randomUUID,
      api: listeningApi,
      changed: (next) => {
        if (__DEV__ && diagnosticPhase !== next.phase) console.info('[murmur-voice] state', { phase: next.phase, microphone: next.microphone, error: Boolean(next.error) });
        diagnosticPhase = next.phase;
        if (alive) setState(next);
      },
      audio: {
        position: () => Number.isFinite(player.currentTime) ? player.currentTime : 0,
        load: async (episode, position, signal) => {
          if (!episode.audioPath) throw new Error('That episode’s audio is unavailable.');
          const uri = episode.audioPath.startsWith('https://') ? episode.audioPath : `${listeningBaseUrl()}${episode.audioPath}`;
          await loadEpisodeAudio(player, { uri, name: episode.title }, position, signal, () => Boolean(statusRef.current.error));
        },
        play: () => { player.play(); }, pause: () => { player.pause(); },
        seek: async (seconds) => { await player.seekTo(seconds, 0, 0); return player.currentTime; },
        // Expo iOS replace expects an AudioSource record, even when clearing it.
        clear: () => { player.replace({}); },
      },
      microphone: {
        async start(onStage) {
          const generation = ++captureGeneration.current;
          if (process.env.EXPO_OS !== 'web') {
            onStage('Checking microphone permission…');
            const permission = await requestRecordingPermissionsAsync();
            if (generation !== captureGeneration.current) return;
            if (!permission.granted) throw new Error('Microphone access is off. Enable Microphone for Expo Go in iPhone Settings, then reopen Murmur.');
          } else {
            // Obtain capture before opening a paid upstream connection. A late
            // permission response after cancellation must immediately release it.
            const web = await startWebPcmCapture(onBuffer);
            if (generation !== captureGeneration.current) { await web.stop(); return; }
            capture.current = web;
          }
          const live = new ContinuousTranscription({
            url: () => voiceGatewayUrl().replace(/\/voice$/, '/live-voice'), ticket: (signal) => listeningApi.liveTicket(signal),
            callbacks: { partial: (text, id) => {
              if (__DEV__ && wakeRequest(text) !== undefined) console.info('[murmur-voice] partial-wake', { phase: instance.state.phase });
              instance.partial(text, id);
            }, final: (text, id) => {
              if (__DEV__) console.info('[murmur-voice] transcript-final', { wake: wakeRequest(text) !== undefined, characters: text.length, phase: instance.state.phase });
              instance.final(text, id);
            },
              activity: () => instance.activity(), error: (error) => { void instance.fail(error); } },
          });
          transcriber.current = live;
          onStage('Connecting to the voice service…');
          await live.start();
          if (generation !== captureGeneration.current) { live.stop(); return; }
          if (process.env.EXPO_OS !== 'web') {
            onStage('Checking microphone audio…');
            await nativeCapture.start();
          }
        },
        async stop() {
          captureGeneration.current++;
          transcriber.current?.stop(); transcriber.current = undefined;
          const web = capture.current; capture.current = undefined;
          await web?.stop().catch(() => undefined);
          if (process.env.EXPO_OS !== 'web') await nativeCapture.stop();
          else await setAudioModeAsync(PLAYBACK_AUDIO_MODE);
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
            onStart: () => { if (!signal.aborted) instance.speechActivity(true); },
            onDone: () => { instance.speechActivity(false); signal.removeEventListener('abort', abort); resolve(); },
            onError: (error) => { instance.speechActivity(false); signal.removeEventListener('abort', abort); reject(error); },
          }).catch((error) => { signal.removeEventListener('abort', abort); reject(error); });
        }),
      },
    });
    controller.current = instance;
    const lifecycle = new ForegroundVoice(instance);
    const foreground = AppState.addEventListener('change', (next) => lifecycle.changed(next));
    lifecycle.changed(AppState.currentState);
    const progress = setInterval(() => { void instance.progress(); }, 10_000);
    const inputHealth = setInterval(() => {
      if (process.env.EXPO_OS !== 'web' && instance.state.microphone && Date.now() - lastInputAt.current > 5000) {
        void instance.fail(new Error('Microphone audio stopped arriving. Close other audio apps, then reopen Murmur.'));
      }
    }, 1000);
    const fetchController = new AbortController();
    void listeningApi.catalog(fetchController.signal).then((episodes) => { if (alive) { setCount(episodes.length); setFeatured(episodes.length === 1 ? episodes[0] : undefined); } }).catch(() => undefined);
    return () => { alive = false; fetchController.abort(); foreground.remove(); clearInterval(progress); clearInterval(inputHealth); void lifecycle.dispose(); };
  }, [onBuffer, player]);
  useEffect(() => { if (status.didJustFinish) void controller.current?.ended(); }, [status.didJustFinish]);
  useEffect(() => {
    if (status.error && state.episode) void controller.current?.fail(new Error('The podcast audio stopped unexpectedly. Your place is saved.'));
  }, [state.episode, status.error]);
  const episodeId = state.episode?.id;
  const audioVersion = state.episode?.audioVersion;
  const captionKey = `${episodeId}:${audioVersion}`;
  useEffect(() => {
    if (!episodeId || !audioVersion) return;
    const abort = new AbortController();
    void listeningApi.captions(episodeId, audioVersion, abort.signal).then((track) => {
      if (!abort.signal.aborted) setCaptionResult({ key: `${episodeId}:${audioVersion}`, cues: track.cues, error: track.cues.length ? undefined : 'No timed captions are available for this recording.' });
    }).catch(() => {
      if (!abort.signal.aborted) setCaptionResult({ key: `${episodeId}:${audioVersion}`, cues: [], error: 'Captions are unavailable. Podcast audio can continue.' });
    });
    return () => abort.abort();
  }, [episodeId, audioVersion]);
  const currentCaptions = captionResult?.key === captionKey ? captionResult : undefined;
  return <Context.Provider value={{ state, seconds: status.currentTime, count, featured, captions: currentCaptions?.cues ?? [], captionsError: currentCaptions?.error, activate: () => { void controller.current?.activate(); } }}>{children}</Context.Provider>;
}
export function useLennyVoice() {
  const value = useContext(Context);
  if (!value) throw new Error('LennyVoiceProvider is missing');
  return value;
}
