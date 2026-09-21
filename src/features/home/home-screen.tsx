import Feather from '@expo/vector-icons/Feather';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Linking,
  Modal,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { AmbientBackdrop } from '@/components/ambient-backdrop';
import { usePodcastCatalog } from '@/data/use-podcast-catalog';
import { useAppTheme } from '@/design/use-app-theme';
import { useReducedMotion } from '@/design/use-reduced-motion';
import type { CatalogEpisode } from '@/domain/podcast';
import {
  ImmersiveDiscoveryStage,
  type ImmersiveDiscoveryPhase,
} from '@/features/home/immersive-discovery-stage';
import { formatDuration, greetingForNow } from '@/features/listening/format';
import { PlayerStage } from '@/features/listening/player-stage';
import { useListeningSession } from '@/features/listening/use-listening-session';
import type { VoiceTakeoverPhase } from '@/features/voice/voice-takeover';

type VoiceSurface = 'discovery' | 'episode' | null;

type VoiceContextSnapshot = {
  episode?: CatalogEpisode;
  playbackMoment?: string;
  returningConversation: boolean;
};

export function HomeScreen() {
  const router = useRouter();
  const routeParams = useLocalSearchParams<{ episode?: string | string[] }>();
  const theme = useAppTheme();
  const reducedMotion = useReducedMotion();
  const { width } = useWindowDimensions();
  const compact = width < 760;
  const catalogState = usePodcastCatalog();
  const session = useListeningSession();
  const activeEpisodeId = session.episode?.id;
  const sessionStarted = session.started;
  const startRoutedEpisode = session.startEpisode;
  const leaveRoutedEpisode = session.leaveListening;
  const scrollRef = useRef<ScrollView>(null);
  const routeOpeningRef = useRef(false);
  const routeClosingRef = useRef(false);
  const handledWakeWordActivationRef = useRef(0);
  const [voiceSurface, setVoiceSurface] = useState<VoiceSurface>(null);
  const [voiceContext, setVoiceContext] = useState<VoiceContextSnapshot>();
  const [voiceInteractionStarted, setVoiceInteractionStarted] = useState(false);
  const [voiceClosing, setVoiceClosing] = useState(false);
  const [recentListen, setRecentListen] = useState<{
    episode: CatalogEpisode;
    playbackMoment: string;
  }>();

  const episodes = useMemo(
    () => (catalogState.status === 'ready' ? catalogState.snapshot.episodes : []),
    [catalogState],
  );
  const routedEpisodeId = Array.isArray(routeParams.episode)
    ? routeParams.episode[0]
    : routeParams.episode;
  const recentCatalogEpisode = recentListen
    ? episodes.find((episode) => episode.id === recentListen.episode.id)
    : undefined;
  const focusedEpisode = recentCatalogEpisode ?? episodes[0];
  const backdropEpisode = session.episode ?? focusedEpisode;
  const takeoverCompleted =
    (voiceSurface === 'discovery' && session.started) ||
    (voiceSurface === 'episode' && voiceInteractionStarted && session.mode === 'playback');
  const episodeTakeoverOpen = voiceSurface === 'episode';
  const takeoverVisible = episodeTakeoverOpen && !voiceClosing && !takeoverCompleted;

  useEffect(() => {
    if (!takeoverCompleted) return;

    const timer = setTimeout(() => {
      if (
        voiceSurface === 'discovery' &&
        session.episode &&
        routedEpisodeId !== session.episode.id
      ) {
        routeOpeningRef.current = true;
        router.setParams({ episode: session.episode.id });
      }
      setVoiceSurface(null);
      setVoiceContext(undefined);
      setVoiceInteractionStarted(false);
    }, 0);
    return () => clearTimeout(timer);
  }, [router, routedEpisodeId, session.episode, takeoverCompleted, voiceSurface]);

  useEffect(() => {
    const activation = session.wakeWordActivation;
    if (
      !activation ||
      activation.id === handledWakeWordActivationRef.current ||
      !session.episode
    ) {
      return;
    }

    handledWakeWordActivationRef.current = activation.id;
    setVoiceContext({
      episode: session.episode,
      playbackMoment: formatDuration(activation.playbackPositionSeconds),
      returningConversation: session.turns.length > 0,
    });
    setVoiceInteractionStarted(true);
    setVoiceClosing(false);
    setVoiceSurface('episode');
  }, [session.episode, session.turns.length, session.wakeWordActivation]);

  useEffect(() => {
    if (catalogState.status !== 'ready') return;

    if (routedEpisodeId) {
      if (routeClosingRef.current) return;
      const openedInsideMurmur = routeOpeningRef.current;
      routeOpeningRef.current = false;
      const routedEpisode =
        episodes.find((item) => item.id === routedEpisodeId) ??
        (session.episode?.id === routedEpisodeId ? session.episode : undefined);
      if (!routedEpisode) {
        routeClosingRef.current = true;
        router.setParams({ episode: undefined });
        if (sessionStarted) void leaveRoutedEpisode();
        return;
      }
      if (openedInsideMurmur) return;
      if (activeEpisodeId !== routedEpisode.id) {
        void startRoutedEpisode(routedEpisode);
      }
      return;
    }

    if (routeOpeningRef.current || voiceSurface === 'discovery') return;
    if (routeClosingRef.current) {
      routeClosingRef.current = false;
      return;
    }
    if (sessionStarted) {
      if (voiceSurface === 'episode') {
        setTimeout(() => {
          setVoiceSurface(null);
          setVoiceContext(undefined);
          setVoiceInteractionStarted(false);
          setVoiceClosing(false);
        }, 0);
      }
      void leaveRoutedEpisode();
    }
  }, [
    catalogState.status,
    episodes,
    routedEpisodeId,
    router,
    activeEpisodeId,
    leaveRoutedEpisode,
    session.episode,
    sessionStarted,
    startRoutedEpisode,
    voiceSurface,
  ]);

  const returnToDiscovery = () => {
    if (session.episode) {
      setRecentListen({
        episode: session.episode,
        playbackMoment: formatDuration(session.currentTime),
      });
    }
    setVoiceSurface(null);
    setVoiceContext(undefined);
    setVoiceInteractionStarted(false);
    setVoiceClosing(false);
    routeOpeningRef.current = false;
    routeClosingRef.current = true;
    router.setParams({ episode: undefined });
    void session.leaveListening();
    scrollRef.current?.scrollTo({ y: 0, animated: !reducedMotion });
  };

  const openDiscoveryVoice = () => {
    router.push({ pathname: '/listen', params: { voice: '1' } });
  };

  const openEpisodeVoice = () => {
    const returnAnchor = session.prepareVoice();
    setVoiceContext({
      episode: session.episode,
      playbackMoment: formatDuration(returnAnchor ?? session.currentTime),
      returningConversation: session.turns.length > 0,
    });
    setVoiceInteractionStarted(true);
    setVoiceClosing(false);
    setVoiceSurface('episode');
    void session.beginVoice();
  };

  const beginEpisodeVoice = () => {
    setVoiceInteractionStarted(true);
    void session.beginVoice();
  };

  const openDeviceSettings = () => {
    void Linking.openSettings().catch(() => undefined);
  };

  const closeVoiceSurface = async () => {
    const closingSurface = voiceSurface;
    if (!closingSurface || voiceClosing) return;

    setVoiceClosing(true);
    try {
      if (closingSurface === 'discovery') {
        await session.cancelDiscoveryVoice();
      } else if (closingSurface === 'episode') {
        await session.cancelVoice();
      }
    } catch {
      // Closing the voice surface must always return control to the underlying screen.
    } finally {
      setVoiceContext(undefined);
      setVoiceInteractionStarted(false);
      setVoiceSurface(null);
      setVoiceClosing(false);
    }
  };

  const episodeTakeoverPhase: VoiceTakeoverPhase =
    session.mode === 'listening'
      ? 'listening'
      : session.mode === 'processing'
        ? session.activityMessage?.toLowerCase().includes('opening')
          ? 'arming'
          : 'processing'
        : session.mode === 'speaking'
          ? 'speaking'
          : session.mode === 'exploring'
            ? 'exploring'
          : session.mode === 'error'
            ? 'error'
            : 'welcome';
  const takeoverPhase: VoiceTakeoverPhase = voiceInteractionStarted
    ? episodeTakeoverPhase
    : 'welcome';
  const immersiveEpisodePhase: ImmersiveDiscoveryPhase = takeoverPhase === 'welcome'
    ? 'idle'
    : takeoverPhase === 'arming'
      ? 'arming'
      : takeoverPhase === 'listening'
        ? 'listening'
        : takeoverPhase === 'error'
          ? 'error'
          : 'processing';
  const immersiveEpisodeVoiceVisible = takeoverVisible && ![
    'speaking',
    'exploring',
  ].includes(takeoverPhase);
  const responseTakeoverVisible = takeoverVisible && (
    takeoverPhase === 'speaking' || takeoverPhase === 'exploring'
  );
  const discoveryPhase =
    voiceSurface === 'discovery' &&
    voiceInteractionStarted &&
    session.discoveryVoice.phase === 'idle'
      ? 'arming'
      : session.discoveryVoice.phase;
  const playbackMoment = voiceContext?.playbackMoment ?? formatDuration(session.currentTime);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.canvas }}>
      {session.started ? (
        <AmbientBackdrop
          accent={backdropEpisode?.accent}
          accentSoft={backdropEpisode?.accentSoft}
          compact={compact}
          theme={theme}
        />
      ) : null}

      <ScrollView
        ref={scrollRef}
        accessibilityElementsHidden={episodeTakeoverOpen}
        aria-hidden={episodeTakeoverOpen}
        contentInsetAdjustmentBehavior="never"
        importantForAccessibility={episodeTakeoverOpen ? 'no-hide-descendants' : 'auto'}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        style={{ flex: 1, pointerEvents: episodeTakeoverOpen ? 'none' : 'auto' }}
        contentContainerStyle={
          session.started
            ? { flexGrow: 1, paddingBottom: 0 }
            : { flexGrow: 1 }
        }
      >
        <View
          style={
            session.started
              ? {
                  width: '100%',
                  maxWidth: compact ? undefined : 1320,
                  alignSelf: 'center',
                  flex: 1,
                  gap: compact ? 0 : 44,
                  paddingTop: compact ? 0 : 34,
                  paddingHorizontal: compact ? 0 : 44,
                }
              : { width: '100%', flex: 1 }
          }
        >
          {!session.started ? (
            <ImmersiveDiscoveryStage
              catalogErrorMessage={
                catalogState.status === 'error' ? catalogState.message : undefined
              }
              catalogStatus={catalogState.status}
              episodes={episodes}
              errorKind={session.discoveryVoice.errorKind}
              greeting={greetingForNow()}
              idleTitle="Hey Murmur"
              idleSubtitle="Tap to play, ask, or explore."
              requiresCatalog={false}
              message={session.discoveryVoice.message}
              metering={session.recordingMetering ?? undefined}
              onCancel={() => void closeVoiceSurface()}
              onOpenSettings={openDeviceSettings}
              onPrimaryPress={openDiscoveryVoice}
              onRetryFeed={catalogState.retry}
              phase={discoveryPhase}
              reducedMotion={reducedMotion}
              theme={theme}
              transcript={session.discoveryVoice.transcript}
            />
          ) : null}

          {session.started && session.episode ? (
            <View style={{ flex: 1, gap: compact ? 0 : 26, paddingHorizontal: compact ? 0 : 0 }}>
              {session.notice ? (
                <View
                  accessibilityLiveRegion="polite"
                  style={{
                    minHeight: 44,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 9,
                    marginHorizontal: compact ? 4 : 0,
                    paddingHorizontal: 14,
                    borderRadius: 22,
                    borderCurve: 'continuous',
                    borderWidth: 1,
                    borderColor: 'rgba(233,162,103,0.28)',
                    backgroundColor: 'rgba(89,51,31,0.72)',
                  }}
                >
                  <Feather name="check-circle" size={15} color={theme.colors.coral} />
                  <Text
                    style={{
                      color: theme.colors.ink,
                      fontFamily: theme.fonts.semibold,
                      fontSize: 10,
                      letterSpacing: 0.35,
                    }}
                  >
                    {session.notice}
                  </Text>
                </View>
              ) : null}

              <View style={{ width: '100%', flex: 1 }}>
                <PlayerStage
                  compact={compact}
                  episode={session.episode}
                  started={session.started}
                  playing={session.playing}
                  buffering={session.buffering}
                  playbackIssue={session.playbackIssue}
                  currentTime={session.currentTime}
                  duration={session.duration}
                  playbackRate={session.playbackRate}
                  mode={session.mode}
                  transcriptStatus={session.transcriptStatus}
                  wakeWordStatus={session.wakeWordStatus}
                  adSkipAvailable={session.adSkipAvailable}
                  activeAdEndSeconds={session.activeAdEndSeconds}
                  onPlay={session.togglePlayback}
                  onRetryPlayback={() => void session.retryPlayback()}
                  onTogglePlayback={session.togglePlayback}
                  onSeek={session.seekTo}
                  onSeekBy={session.seekBy}
                  onCycleRate={session.cyclePlaybackRate}
                  onMicPress={openEpisodeVoice}
                  onSkipAd={() => void session.handleSkipAd()}
                  onBack={returnToDiscovery}
                  theme={theme}
                />
              </View>
            </View>
          ) : null}

        </View>
      </ScrollView>

      <Modal
        animationType={reducedMotion ? 'none' : 'fade'}
        onRequestClose={() => void closeVoiceSurface()}
        presentationStyle="fullScreen"
        statusBarTranslucent
        visible={immersiveEpisodeVoiceVisible}
      >
        <ImmersiveDiscoveryStage
          backgroundEpisode={session.episode}
          catalogErrorMessage={
            catalogState.status === 'error' ? catalogState.message : undefined
          }
          catalogStatus={catalogState.status}
          episodes={episodes}
          idleTitle="What caught your attention?"
          message={takeoverPhase === 'error' ? session.response : session.activityMessage}
          metering={session.recordingMetering ?? undefined}
          onCancel={() => void closeVoiceSurface()}
          onOpenSettings={openDeviceSettings}
          onPrimaryPress={beginEpisodeVoice}
          onRetryFeed={catalogState.retry}
          phase={immersiveEpisodePhase}
          reducedMotion={reducedMotion}
          theme={theme}
          transcript={session.transcriptText}
        />
      </Modal>

      <Modal
        animationType={reducedMotion ? 'none' : 'fade'}
        onRequestClose={() => void closeVoiceSurface()}
        presentationStyle="fullScreen"
        statusBarTranslucent
        visible={responseTakeoverVisible}
      >
        <ImmersiveDiscoveryStage
          backgroundEpisode={session.episode}
          catalogErrorMessage={
            catalogState.status === 'error' ? catalogState.message : undefined
          }
          catalogStatus={catalogState.status}
          episodes={episodes}
          idleTitle={
            takeoverPhase === 'exploring'
              ? 'The thread is open.'
              : 'Here’s the thread.'
          }
          message={
            voiceContext?.episode
              ? `${voiceContext.episode.podcastTitle} · ${playbackMoment}`
              : 'This is Murmur responding, not the podcast stream.'
          }
          metering={session.recordingMetering ?? undefined}
          onCancel={() => void session.returnToEpisode()}
          onOpenSettings={openDeviceSettings}
          onPrimaryPress={beginEpisodeVoice}
          onRetryFeed={catalogState.retry}
          phase="idle"
          reducedMotion={reducedMotion}
          response={session.response}
          theme={theme}
          transcript=""
        />
      </Modal>
    </View>
  );
}
