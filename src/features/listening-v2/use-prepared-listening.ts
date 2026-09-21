import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus, useAudioStream } from 'expo-audio';
import * as Crypto from 'expo-crypto';
import type { ListeningSession, Observation, PreparedEpisode, TurnResult } from '../../../shared/listening';
import { ListeningApiError, listeningApi, listeningBaseUrl, voiceGatewayUrl } from '@/services/api/listening-client';
import { RealtimeTranscriptionSession, type WebSocketLike } from '@/services/voice/realtime-transcription';
import { startWebPcmCapture, type WebPcmCapture } from '@/services/voice/web-pcm-capture';
import { PLAYBACK_AUDIO_MODE, RECORDING_AUDIO_MODE } from '@/features/listening/audio-mode';
import { useAssistantVoice } from '@/features/listening/use-assistant-voice';

type Phase = 'loading' | 'paused' | 'playing' | 'arming' | 'listening' | 'thinking' | 'speaking' | 'exploring' | 'error';
export function usePreparedListening({ activateVoiceOnOpen = false }: { activateVoiceOnOpen?: boolean } = {}) {
  const player = useAudioPlayer(null, { updateInterval: 150 });
  const playback = useAudioPlayerStatus(player);
  const { speak, stop: stopSpeech } = useAssistantVoice();
  const [episode, setEpisode] = useState<PreparedEpisode>();
  const [session, setSession] = useState<ListeningSession>();
  const [phase, setPhase] = useState<Phase>('loading');
  const [message, setMessage] = useState<string>();
  const [transcript, setTranscript] = useState('');
  const [answer, setAnswer] = useState<TurnResult>();
  const [positionRestored, setPositionRestored] = useState(false);
  const activationHandled = useRef(false);
  const restored = useRef<string | undefined>(undefined);
  const sessionRef = useRef<ListeningSession | undefined>(undefined);
  const operation = useRef(0);
  const request = useRef<AbortController | undefined>(undefined);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const voice = useRef<RealtimeTranscriptionSession | undefined>(undefined);
  const webCapture = useRef<WebPcmCapture | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const finalizing = useRef(false);
  const finishRef = useRef<() => Promise<void>>(async () => {});
  const speechSeen = useRef(false);
  const silenceStarted = useRef<number | undefined>(undefined);
  const actionsApplied = useRef(new Set<string>());
  const mounted = useRef(true);

  const update = useCallback((next: ListeningSession) => { sessionRef.current = next; if (mounted.current) setSession(next); }, []);
  const serialize = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const next = queue.current.catch(() => undefined).then(work);
    queue.current = next.catch(() => undefined);
    return next;
  }, []);
  const onPcm = useCallback((chunk: { data: ArrayBuffer; sampleRate: number; channels: number }) => {
    if (finalizing.current || !voice.current) return;
    voice.current.appendPcm(chunk.data, chunk.sampleRate, chunk.channels);
    const samples = new Int16Array(chunk.data);
    let sum = 0;
    for (let i = 0; i < samples.length; i += 8) sum += ((samples[i] ?? 0) / 32768) ** 2;
    const rms = Math.sqrt(sum / Math.max(1, Math.ceil(samples.length / 8)));
    if (rms > 0.008) { speechSeen.current = true; silenceStarted.current = undefined; }
    else if (speechSeen.current && rms < 0.0045) {
      silenceStarted.current ??= Date.now();
      if (Date.now() - silenceStarted.current > 1200) void finishRef.current();
    } else silenceStarted.current = undefined;
  }, []);
  const { stream } = useAudioStream({ channels: 1, encoding: 'int16', sampleRate: 24_000, onBuffer: onPcm });
  const stopCapture = useCallback(async () => {
    clearTimeout(timer.current); timer.current = undefined;
    const capture = webCapture.current; webCapture.current = undefined;
    await capture?.stop().catch(() => undefined);
    if (process.env.EXPO_OS !== 'web') { try { stream.stop(); } catch { /* Already stopped. */ } }
    await setAudioModeAsync(PLAYBACK_AUDIO_MODE).catch(() => undefined);
  }, [stream]);
  const stop = useCallback(async () => {
    const expected = ++operation.current;
    request.current?.abort(); request.current = undefined;
    voice.current?.cancel(); voice.current = undefined;
    await Promise.all([stopCapture(), stopSpeech()]);
    return expected;
  }, [stopCapture, stopSpeech]);
  const refresh = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) throw new Error('The listening session is not ready yet.');
    const next = await listeningApi.session(current.id);
    update(next); return next;
  }, [update]);
  const fail = useCallback((error: unknown, expected: number) => {
    if (!mounted.current || operation.current !== expected) return;
    setMessage(error instanceof Error ? error.message : 'That request could not be completed. Your place is saved.');
    setPhase('error');
  }, []);
  const observeNow = useCallback(async (reason: Observation['reason'], position: number, expected: number) => {
    // A cancelled provider request may finish releasing its database revision after
    // the next client observation starts. Only the current local intent may retry.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fresh = await refresh();
      if (operation.current !== expected) return undefined;
      try {
        const next = await listeningApi.observe(fresh, reason, position);
        if (operation.current === expected) update(next);
        return next;
      } catch (error) {
        if (!(error instanceof ListeningApiError) || error.code !== 'stale_session' || attempt === 1) throw error;
      }
    }
  }, [refresh, update]);

  const load = useCallback(async () => {
    const expected = ++operation.current;
    setPhase('loading'); setMessage(undefined); setPositionRestored(false);
    restored.current = undefined;
    try {
      const prepared = await listeningApi.episode();
      if (operation.current !== expected || !mounted.current) return;
      setEpisode(prepared);
      if (prepared.status !== 'ready' || !prepared.audioPath) { setMessage('Your episode is being prepared. Try again in a moment.'); setPhase('error'); return; }
      let opened = await listeningApi.open(prepared.id);
      if (operation.current !== expected || !mounted.current) return;
      // Resuming never replays a pending action from a previous client connection.
      const position = opened.bookmarkSeconds ?? opened.positionSeconds;
      opened = await listeningApi.observe(opened, 'cancel', position);
      if (operation.current !== expected || !mounted.current) return;
      update(opened);
      await setAudioModeAsync(PLAYBACK_AUDIO_MODE);
      player.replace({ uri: `${listeningBaseUrl()}${prepared.audioPath}`, name: prepared.title });
      setPhase('paused');
    } catch (error) { fail(error, expected); }
  }, [fail, player, update]);
  useEffect(() => {
    if (!playback.isLoaded || !session || restored.current === session.id) return;
    restored.current = session.id;
    const expected = operation.current;
    void player.seekTo(session.bookmarkSeconds ?? session.positionSeconds)
      .then(() => { if (mounted.current && operation.current === expected) setPositionRestored(true); })
      .catch((error) => fail(error, expected));
  }, [fail, playback.isLoaded, player, session]);

  const submit = useCallback(async (utterance: string) => {
    const expected = await stop();
    if (operation.current !== expected) return;
    player.pause();
    setTranscript(utterance); setMessage(undefined); setPhase('thinking');
    const controller = new AbortController(); request.current = controller;
    try {
      await serialize(async () => {
        const current = await refresh();
        if (operation.current !== expected) return;
        const result = await listeningApi.turn(current, utterance, player.currentTime, Crypto.randomUUID(), controller.signal);
        if (operation.current !== expected || controller.signal.aborted) return;
        update(result.session); setAnswer(result);
        if (result.action) {
          if (actionsApplied.current.has(result.action.id)) return;
          actionsApplied.current.add(result.action.id);
          await player.seekTo(result.action.positionSeconds);
          if (operation.current !== expected) return;
          const actual = player.currentTime;
          update(await listeningApi.acknowledge(result.session, result.action.id, actual));
          if (operation.current !== expected) return;
          if (result.action.play) player.play(); else player.pause();
          setPhase(result.action.play ? 'playing' : 'paused'); setAnswer(undefined); return;
        }
        setPhase('speaking');
        await speak(result.answer, {
          signal: controller.signal,
          loadSpeech: (signal) => listeningApi.speech(result.session.id, result.requestId, signal),
          onDone: () => {
            if (operation.current !== expected || !mounted.current) return;
            setPhase('exploring');
            void serialize(() => observeNow('speech-ended', player.currentTime, expected)).catch((error) => fail(error, expected));
          },
        });
      });
    } catch (error) { fail(error, expected); }
  }, [fail, observeNow, player, refresh, serialize, speak, stop, update]);

  const finishVoice = useCallback(async () => {
    const current = voice.current;
    if (!current || finalizing.current) return;
    finalizing.current = true;
    const expected = operation.current;
    setPhase('thinking');
    try {
      await stopCapture();
      const text = await current.finish();
      current.cancel();
      if (voice.current === current) voice.current = undefined;
      if (operation.current !== expected) return;
      if (!text.trim()) throw new Error('I did not catch that. Tap the microphone to try again.');
      await submit(text);
    } catch (error) { current.cancel(); fail(error, expected); }
  }, [fail, stopCapture, submit]);
  useEffect(() => { finishRef.current = finishVoice; }, [finishVoice]);

  const beginVoice = useCallback(async () => {
    player.pause();
    const position = player.currentTime;
    const expected = await stop();
    if (operation.current !== expected) return;
    setMessage(undefined); setTranscript(''); setPhase('arming');
    finalizing.current = false; speechSeen.current = false; silenceStarted.current = undefined;
    try {
      if (process.env.EXPO_OS !== 'web') {
        const permission = await requestRecordingPermissionsAsync();
        if (operation.current !== expected) return;
        if (!permission.granted) throw new Error('Allow microphone access in Settings to speak to Murmur.');
      }
      const current = await serialize(() => observeNow('interrupt', position, expected));
      if (!current || operation.current !== expected) return;
      const live = new RealtimeTranscriptionSession({
        onPartialTranscript: (text) => { if (operation.current === expected) setTranscript(text); },
        onError: (error) => { if (operation.current === expected) { void stopCapture(); fail(error, expected); } },
      }, {
        createToken: (_surface, options) => listeningApi.ticket(current.id, options?.signal),
        createWebSocket: (_url, protocols) => {
          const secret = protocols.find((item) => item.startsWith('openai-insecure-api-key.'))!.slice('openai-insecure-api-key.'.length);
          return new WebSocket(voiceGatewayUrl(), [`murmur-ticket.${secret}`]) as unknown as WebSocketLike;
        },
        connectAttempts: 1,
      });
      voice.current = live;
      await live.connect('episode');
      if (operation.current !== expected) { live.cancel(); return; }
      if (process.env.EXPO_OS === 'web') {
        const capture = await startWebPcmCapture(onPcm);
        if (operation.current !== expected) { await capture.stop(); return; }
        webCapture.current = capture;
      } else {
        await setAudioModeAsync(RECORDING_AUDIO_MODE);
        await stream.start();
        if (operation.current !== expected) { await stream.stop(); return; }
      }
      setPhase('listening');
      timer.current = setTimeout(() => { void finishRef.current(); }, 12_000);
    } catch (error) {
      if (operation.current !== expected) return;
      voice.current?.cancel(); voice.current = undefined; await stopCapture(); fail(error, expected);
    }
  }, [fail, observeNow, onPcm, player, serialize, stop, stopCapture, stream]);

  useEffect(() => {
    if (!activateVoiceOnOpen || activationHandled.current || !positionRestored || phase !== 'paused') return;
    // Consume the home-screen tap once; state changes and permission errors must
    // never start another microphone session without another explicit action.
    activationHandled.current = true;
    void beginVoice();
  }, [activateVoiceOnOpen, beginVoice, phase, positionRestored]);

  const control = useCallback(async (kind: 'play' | 'pause' | 'seek', target?: number) => {
    const shouldPlay = kind === 'play';
    player.pause();
    const expected = await stop();
    if (operation.current !== expected) return;
    setMessage(undefined); setAnswer(undefined);
    try {
      if (target !== undefined) await player.seekTo(Math.max(0, Math.min(episode?.durationSeconds ?? 0, target)));
      if (operation.current !== expected) return;
      if (shouldPlay) player.play();
      setPhase(shouldPlay ? 'playing' : 'paused');
      const position = player.currentTime;
      await serialize(() => observeNow(kind, position, expected));
    } catch (error) { fail(error, expected); }
  }, [episode, fail, observeNow, player, serialize, stop]);
  const backgroundRef = useRef<() => void>(() => {});
  useEffect(() => { backgroundRef.current = () => { void control('pause'); }; }, [control]);
  useEffect(() => {
    // iOS permission dialogs briefly make the app inactive. Let the initiating
    // tap continue after permission is granted; leaving the app still stops audio.
    const listener = AppState.addEventListener('change', (state) => { if (state === 'background') backgroundRef.current(); });
    return () => listener.remove();
  }, []);
  useEffect(() => {
    if (phase !== 'playing') return;
    const interval = setInterval(() => {
      const expected = operation.current;
      const position = player.currentTime;
      void serialize(() => observeNow('progress', position, expected)).catch((error) => fail(error, expected));
    }, 5000);
    return () => clearInterval(interval);
  }, [fail, observeNow, phase, player, serialize]);
  useEffect(() => {
    if (!playback.didJustFinish) return;
    const finished = setTimeout(() => { void control('pause'); }, 0);
    return () => clearTimeout(finished);
  }, [control, playback.didJustFinish]);
  useEffect(() => {
    mounted.current = true;
    const startup = setTimeout(() => { void load(); }, 0);
    return () => { clearTimeout(startup); mounted.current = false; void stop(); };
  }, [load, stop]);
  return { episode, session, phase, message, transcript, answer, playback,
    retry: load, beginVoice, finishVoice,
    playPause: () => control(playback.playing ? 'pause' : 'play'),
    seek: (seconds: number) => control('seek', seconds),
    returnToEpisode: () => submit('return to the podcast'),
    stopAnswer: () => control('pause'),
  };
}
