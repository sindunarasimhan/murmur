import { useEffect } from 'react';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { Easing, FadeIn, FadeOut, LinearTransition, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { demoEpisode } from '@/data/demo-episode';
import { useReducedMotion } from '@/design/use-reduced-motion';
import { AmbientPodcastRail } from '@/features/home/ambient-podcast-rail';
import { MurmurMascot } from './murmur-mascot';
import type { VoiceState } from './voice-controller';
import { formatDuration } from '@/features/listening/format';
import { captionAt, type PlaybackCaption } from './playback-captions';
import { detailPresentation } from './detail-presentation';

const backgroundEpisodes = [demoEpisode];

type Props = { state: VoiceState; playbackEntered?: boolean; seconds?: number; captions?: readonly PlaybackCaption[]; captionsError?: string };

export function InvocationStage({ state, playbackEntered = false, seconds = 0, captions = [], captionsError }: Props) {
  const insets = useSafeAreaInsets();
  const { width, height, fontScale } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const listening = state.microphone && (state.phase === 'listening' || state.phase === 'followup' || Boolean(state.followupOpen));
  const playback = Boolean(state.episode && playbackEntered);
  const detail = detailPresentation(state);
  const transition = useSharedValue(playback ? 1 : 0);
  const mascotSize = Math.min(width - 24, height * 0.44, 390);
  const compactSize = 116;
  useEffect(() => {
    transition.value = withTiming(playback ? 1 : 0, { duration: reducedMotion ? 0 : 480, easing: Easing.inOut(Easing.cubic) });
  }, [playback, reducedMotion, transition]);
  const mascotSpace = useAnimatedStyle(() => ({ height: mascotSize + (compactSize - mascotSize) * transition.value }));
  const mascotMotion = useAnimatedStyle(() => ({ transform: [{ translateY: -(mascotSize - compactSize) / 2 * transition.value }, { scale: 1 - (1 - compactSize / mascotSize) * transition.value }] }));
  const playerStyle = useAnimatedStyle(() => ({ opacity: transition.value, transform: [{ translateY: 18 * (1 - transition.value) }] }));
  const transcript = captionAt(captions, seconds, Math.floor(Math.min(width - 52, 430) / (12 * fontScale)) * 2);
  const captionStatus = captionsError || !state.episode?.transcriptReady ? 'Captions unavailable' : !captions.length ? 'Loading captions…' : '';
  const label = state.error ? state.microphone ? 'Ready to retry' : 'Connection interrupted' : listening ? 'Listening' : state.phase === 'thinking' ? 'Thinking' : state.phase === 'speaking' ? state.speechPlaying ? 'Speaking' : 'Thinking' : state.phase === 'connecting' ? 'Connecting' : state.microphone ? 'Ready' : 'Mic off';
  const showReply = Boolean(state.error) || state.phase === 'speaking';
  return <View style={styles.root}>
    <StatusBar style="dark" />
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[StyleSheet.absoluteFill, { opacity: 0.12 }]}>
      <AmbientPodcastRail episodes={backgroundEpisodes} reducedMotion={reducedMotion} speed={10} />
    </View>
    <LinearGradient pointerEvents="none" colors={['rgba(249,244,234,0.72)', 'rgba(249,244,234,0.2)', '#F1E8D9']} locations={[0, 0.4, 1]} style={StyleSheet.absoluteFill} />
    <ScrollView contentInsetAdjustmentBehavior="never" contentContainerStyle={[styles.page, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 20 }]}>
      <View style={styles.header}>
        <Text style={styles.brand}>murmur</Text>
        <View style={styles.mic}><View style={[styles.dot, { backgroundColor: state.microphone ? '#728064' : '#B8A990' }]} /><Text style={styles.micText}>{state.microphone ? 'Mic on' : 'Mic off'}</Text></View>
      </View>
      <View style={styles.stage}>
        {!playback ? <Animated.View style={{ width: '100%', flexShrink: 0 }} entering={reducedMotion ? undefined : FadeIn.duration(200)} exiting={reducedMotion ? undefined : FadeOut.duration(200)}>
          <Text style={styles.title}>What would you like to hear?</Text>
        </Animated.View> : null}
        <Animated.View layout={reducedMotion ? undefined : LinearTransition.duration(250)} style={[styles.mascot, { width: mascotSize }, mascotSpace]}><Animated.View style={mascotMotion}><MurmurMascot size={mascotSize} phase={state.speechPlaying ? 'speaking' : listening ? 'listening' : state.phase === 'speaking' ? 'thinking' : state.phase} level={state.speechLevel} reducedMotion={reducedMotion} /></Animated.View></Animated.View>
        {playback ? <View testID="detail-voice" style={styles.detailVoice}>
          <View style={styles.labelRow}><View style={[styles.dot, { backgroundColor: detail.error ? '#A36648' : state.microphone ? '#7B876C' : '#B8A990' }]} /><Text testID="detail-voice-status" accessibilityLabel={`Voice: ${detail.voiceStatus}`} style={styles.label}>{detail.voiceStatus}</Text></View>
          {detail.heard ? <Text testID="detail-heard" selectable numberOfLines={2} accessibilityLabel={`You said: ${detail.heard}`} style={[styles.transcript, styles.playbackHeard]}>“{detail.heard}”</Text> : null}
          {detail.reply ? <Text testID="detail-reply" selectable numberOfLines={2} accessibilityLiveRegion="polite" accessibilityRole={detail.error ? 'alert' : 'text'} style={[styles.caption, detail.error && styles.error]}>{detail.reply}</Text> : null}
        </View> : <View style={styles.labelRow}><View style={[styles.dot, { backgroundColor: state.error ? '#A36648' : '#7B876C' }]} /><Text style={styles.label}>{label}</Text></View>}
        {playback && state.episode ? <Animated.View testID="detail-player" style={[styles.player, playerStyle]}>
          <View style={styles.artworkFrame}>
            {state.episode.artworkUrl ? <Image source={{ uri: state.episode.artworkUrl }} style={styles.artwork} contentFit="cover" accessibilityLabel={`${state.episode.showTitle} artwork`} /> : <View style={[styles.artwork, styles.artworkFallback]}><Text style={styles.brand}>{state.episode.showTitle}</Text></View>}
          </View>
          <Text selectable accessibilityLabel={`${state.episode.guest}. ${state.episode.title}`} style={styles.episodeGuest}>{state.episode.guest}</Text>
          <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${Math.max(0, Math.min(100, seconds / Math.max(1, state.episode.durationSeconds) * 100))}%` }]} /></View>
          <Text testID="detail-playback-status" style={styles.time}>{detail.playbackStatus ? `${detail.playbackStatus} · ` : ''}{formatDuration(seconds)} / {formatDuration(state.episode.durationSeconds)}</Text>
          {state.phase === 'playing' || state.phase === 'paused' ? <View style={styles.episodeTranscript}>
            <Text selectable numberOfLines={2} style={styles.currentLine}>{transcript || captionStatus || ' '}</Text>
          </View> : null}
        </Animated.View> : null}
        {!playback ? <View style={styles.conversation}>
          {state.heard ? <Text selectable numberOfLines={2} style={styles.transcript}>“{state.heard}”</Text> : null}
          {showReply ? <Text selectable accessibilityLiveRegion="polite" accessibilityRole={state.error ? 'alert' : 'text'} style={[styles.caption, state.error && styles.error]}>{state.caption}</Text> : null}
        </View> : null}
      </View>
      {!playback ? <View style={styles.footer}>
        {state.phase === 'idle' ? <Text style={styles.hint}>{state.microphone ? 'Say “Hey Murmur” to begin.' : 'Reopen the app to listen.'}</Text> : null}
        <Text style={styles.disclosure}>Mic audio is sent to OpenAI, including while waiting for “Hey Murmur.” Replies use an AI voice.</Text>
      </View> : null}
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F6EFE3' },
  page: { flexGrow: 1, paddingHorizontal: 26, alignSelf: 'center', width: '100%', maxWidth: 760 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { color: '#514A3D', fontFamily: 'Newsreader_400Regular', fontSize: 32, letterSpacing: -1.7 },
  mic: { flexDirection: 'row', alignItems: 'center', gap: 6 }, dot: { width: 5, height: 5, borderRadius: 4 },
  micText: { color: '#807562', fontSize: 11, fontFamily: 'Manrope_500Medium' },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'flex-start', paddingTop: 24, paddingBottom: 24 },
  title: { color: '#514A3D', fontFamily: 'Newsreader_400Regular', fontSize: 37, lineHeight: 44, textAlign: 'center', marginTop: 12 },
  mascot: { marginTop: 2, marginBottom: 4 },
  player: { alignItems: 'center', width: '100%', maxWidth: 430, gap: 9, paddingTop: 20 },
  artworkFrame: { padding: 8, backgroundColor: '#F4EDE1', borderRadius: 26, borderCurve: 'continuous', boxShadow: '8px 10px 22px #D5C9B6, -6px -6px 18px #FFFBF3', marginBottom: 9 },
  artwork: { width: 174, height: 174, borderRadius: 19 },
  artworkFallback: { alignItems: 'center', justifyContent: 'center', padding: 18 },
  episodeGuest: { color: '#514A3D', fontFamily: 'Newsreader_400Regular', fontSize: 28, lineHeight: 32, textAlign: 'center' },
  progressTrack: { width: '82%', height: 3, backgroundColor: '#DED4C4', borderRadius: 3, overflow: 'hidden', marginTop: 6 },
  progressFill: { height: '100%', backgroundColor: '#818C71' },
  time: { color: '#928571', fontFamily: 'Manrope_400Regular', fontSize: 10, fontVariant: ['tabular-nums'] },
  episodeTranscript: { minHeight: 68, width: '100%', alignItems: 'center', justifyContent: 'center', paddingTop: 10 },
  currentLine: { color: '#585344', fontFamily: 'Newsreader_400Regular', fontSize: 22, lineHeight: 29, textAlign: 'center' },
  detailVoice: { alignItems: 'center', gap: 8, width: '100%', maxWidth: 430 },
  playbackHeard: { fontSize: 19, lineHeight: 25 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { color: '#7F826B', fontFamily: 'Manrope_600SemiBold', fontSize: 9, letterSpacing: 1.8 },
  conversation: { minHeight: 98, alignItems: 'center', justifyContent: 'center', gap: 9, marginTop: 14, maxWidth: 430 },
  transcript: { color: '#504C3F', fontFamily: 'Newsreader_400Regular', fontSize: 26, lineHeight: 32, textAlign: 'center' },
  caption: { color: '#877B68', fontFamily: 'Manrope_400Regular', fontSize: 12, lineHeight: 20, textAlign: 'center' },
  error: { color: '#995D40' },
  footer: { gap: 10, maxWidth: 410, alignSelf: 'center' },
  hint: { color: '#817761', fontFamily: 'Manrope_500Medium', fontSize: 11, lineHeight: 17, textAlign: 'center' },
  disclosure: { color: '#7D705F', fontFamily: 'Manrope_400Regular', fontSize: 10, lineHeight: 15, textAlign: 'center' },
});
