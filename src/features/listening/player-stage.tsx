import Feather from '@expo/vector-icons/Feather';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import type { AppTheme } from '@/design/tokens';
import { useReducedMotion } from '@/design/use-reduced-motion';
import type { CatalogEpisode } from '@/domain/podcast';
import { formatDuration } from '@/features/listening/format';
import type { WakeWordStatus } from '@/services/voice/wake-word';

export type ListeningMode =
  | 'idle'
  | 'loading'
  | 'playback'
  | 'listening'
  | 'processing'
  | 'speaking'
  | 'exploring'
  | 'error';

export type TranscriptStatus = 'loading' | 'ready' | 'unavailable';
export type PlaybackIssue = 'error' | 'ended';

type PlayerStageProps = {
  compact: boolean;
  episode?: CatalogEpisode;
  started: boolean;
  playing: boolean;
  buffering: boolean;
  playbackIssue?: PlaybackIssue;
  currentTime: number;
  duration: number;
  playbackRate: number;
  mode: ListeningMode;
  transcriptStatus: TranscriptStatus;
  wakeWordStatus: WakeWordStatus;
  adSkipAvailable: boolean;
  activeAdEndSeconds?: number;
  onPlay: () => void;
  onRetryPlayback: () => void;
  onTogglePlayback: () => void;
  onSeek: (seconds: number) => void;
  onSeekBy: (seconds: number) => void;
  onCycleRate: () => void;
  onMicPress: () => void;
  onSkipAd: () => void;
  onBack?: () => void;
  theme: AppTheme;
};

const waveBars = [0.38, 0.56, 0.8, 1, 0.72, 0.9, 0.48] as const;

function contextStatus(
  buffering: boolean,
  transcriptStatus: TranscriptStatus,
  playbackIssue?: PlaybackIssue,
) {
  if (playbackIssue === 'error') return 'PLAYBACK NEEDS ATTENTION';
  if (playbackIssue === 'ended') return 'EPISODE FINISHED';
  if (buffering) return 'BUFFERING';
  if (transcriptStatus === 'ready') return 'CONTEXT READY';
  if (transcriptStatus === 'unavailable') return 'CONTEXT LIMITED';
  return 'FINDING CONTEXT';
}

function modeLabel(mode: ListeningMode, playing: boolean, buffering: boolean) {
  if (mode === 'listening') return 'LISTENING';
  if (mode === 'processing') return 'THINKING';
  if (mode === 'speaking') return 'MURMUR SPEAKING';
  if (mode === 'exploring') return 'THREAD OPEN';
  if (mode === 'error') return 'NEEDS ATTENTION';
  if (buffering) return 'BUFFERING';
  return playing ? 'PODCAST PLAYING' : 'PODCAST PAUSED';
}

function PlayingSignal({
  active,
  compact,
  reducedMotion,
  theme,
}: {
  active: boolean;
  compact: boolean;
  reducedMotion: boolean;
  theme: AppTheme;
}) {
  const pulse = useSharedValue(0);

  useEffect(() => {
    if (reducedMotion || !active) {
      pulse.value = withTiming(0, { duration: 220 });
      return;
    }
    pulse.value = withRepeat(
      withTiming(1, { duration: 1050, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, [active, pulse, reducedMotion]);

  const ringStyle = useAnimatedStyle(() => ({
    opacity: active ? 0.2 + pulse.value * 0.28 : 0.1,
    transform: [{ scale: active ? 1 + pulse.value * 0.16 : 1 }],
  }));

  return (
    <View
      accessibilityLabel={active ? 'Podcast audio is playing' : 'Podcast audio is paused'}
      accessibilityRole="image"
      style={{
        width: compact ? 102 : 132,
        height: compact ? 102 : 132,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          {
            position: 'absolute',
            inset: 0,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: active ? 'rgba(233,162,103,0.5)' : theme.colors.line,
            backgroundColor: active ? 'rgba(233,111,132,0.08)' : 'rgba(255,255,255,0.025)',
          },
          ringStyle,
        ]}
      />
      <View
        style={{
          width: compact ? 74 : 92,
          height: compact ? 74 : 92,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 999,
          borderWidth: 1,
          borderColor: 'rgba(246,242,233,0.12)',
          backgroundColor: 'rgba(8,9,11,0.56)',
        }}
      >
        <View
          style={{
            height: compact ? 32 : 38,
            flexDirection: 'row',
            alignItems: 'center',
            gap: compact ? 4 : 5,
          }}
        >
          {waveBars.map((bar, index) => (
            <View
              key={`${bar}-${index}`}
              style={{
                width: compact ? 4 : 5,
                height: active
                  ? (compact ? 8 : 10) + bar * (compact ? 23 : 28)
                  : (compact ? 5 : 7) + bar * 7,
                borderRadius: 999,
                backgroundColor: active ? theme.colors.coral : theme.colors.subtle,
                opacity: active ? 0.92 : 0.46,
              }}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

export function PlayerStage({
  compact,
  episode,
  started,
  playing,
  buffering,
  playbackIssue,
  currentTime,
  duration,
  mode,
  transcriptStatus,
  wakeWordStatus,
  adSkipAvailable,
  activeAdEndSeconds,
  onMicPress,
  onRetryPlayback,
  onBack,
  theme,
}: PlayerStageProps) {
  const reducedMotion = useReducedMotion();
  const drift = useSharedValue(0);
  const voiceBusy = ['listening', 'processing', 'speaking'].includes(mode);

  useEffect(() => {
    if (reducedMotion) {
      drift.value = 0;
      return;
    }
    drift.value = withRepeat(
      withTiming(1, { duration: playing ? 16500 : 24000, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, [drift, playing, reducedMotion]);

  const backgroundMotionStyle = useAnimatedStyle(() => ({
    opacity: 0.32 + drift.value * 0.08,
    transform: [
      { scale: 1.08 + drift.value * (playing ? 0.045 : 0.025) },
      { translateX: (drift.value - 0.5) * (compact ? 18 : 28) },
      { translateY: (drift.value - 0.5) * (compact ? 12 : 18) },
    ],
  }));

  if (!episode) return null;

  const playerDuration = duration || episode.durationSeconds || 1;
  const timeRemaining = Math.max(playerDuration - currentTime, 0);
  const sponsoredRemaining = activeAdEndSeconds === undefined
    ? undefined
    : Math.max(activeAdEndSeconds - currentTime, 0);
  const primaryDisabled = !started || mode === 'loading' || mode === 'processing';

  return (
    <View
      style={{
        minHeight: compact ? 710 : 760,
        overflow: 'hidden',
        borderRadius: compact ? 0 : 38,
        borderCurve: 'continuous',
        borderWidth: compact ? 0 : 1,
        borderColor: 'rgba(246,242,233,0.08)',
        backgroundColor: theme.colors.canvas,
        boxShadow: compact ? undefined : theme.shadow,
      }}
    >
      <Animated.View style={[{ position: 'absolute', inset: -34 }, backgroundMotionStyle]}>
        {episode.bundledArtworkSource || episode.artworkUrl ? (
          <Image
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            source={episode.bundledArtworkSource ?? { uri: episode.artworkUrl }}
            contentFit="cover"
            transition={reducedMotion ? 0 : 420}
            style={{ position: 'absolute', inset: 0 }}
          />
        ) : null}
      </Animated.View>

      <LinearGradient
        colors={[
          'rgba(8,9,11,0.64)',
          'rgba(8,9,11,0.86)',
          'rgba(8,9,11,0.98)',
          '#08090B',
        ]}
        locations={[0, 0.34, 0.72, 1]}
        style={{ position: 'absolute', inset: 0 }}
      />
      <LinearGradient
        colors={['rgba(233,111,132,0.16)', 'transparent', 'rgba(8,9,11,0.58)']}
        locations={[0, 0.48, 1]}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={{ position: 'absolute', inset: 0 }}
      />

      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: compact ? 22 : 30,
          paddingTop: compact ? 30 : 42,
          paddingRight: compact ? 22 : 46,
          paddingBottom: compact ? 34 : 48,
          paddingLeft: compact ? 22 : 46,
        }}
      >
        <View
          style={{
            width: '100%',
            minHeight: 48,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 14,
          }}
        >
          {onBack ? (
            <Pressable
              accessibilityLabel="Back to discovery"
              accessibilityRole="button"
              hitSlop={8}
              onPress={onBack}
              style={({ pressed }) => ({
                width: 44,
                height: 44,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 22,
                borderWidth: 1,
                borderColor: 'rgba(246,242,233,0.14)',
                backgroundColor: 'rgba(8,9,11,0.34)',
                opacity: pressed ? 0.55 : 0.82,
              })}
            >
              <Feather name="arrow-left" size={18} color={theme.colors.ink} />
            </Pressable>
          ) : (
            <View style={{ width: 44, height: 44 }} />
          )}

          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              color: theme.colors.subtle,
              fontFamily: theme.fonts.semibold,
              fontSize: 9,
              letterSpacing: 1.75,
              textAlign: 'center',
            }}
          >
            {contextStatus(buffering, transcriptStatus, playbackIssue)}
          </Text>

          <View style={{ width: 44, height: 44 }} />
        </View>

        <View style={{ width: '100%', alignItems: 'center', gap: compact ? 22 : 28 }}>
          <View style={{ alignItems: 'center', gap: compact ? 12 : 16 }}>
            <PlayingSignal
              active={playing && !buffering && !playbackIssue}
              compact={compact}
              reducedMotion={reducedMotion}
              theme={theme}
            />
            <Text
              accessibilityLiveRegion="polite"
              style={{
                color: playbackIssue === 'error' ? theme.colors.coral : theme.colors.muted,
                fontFamily: theme.fonts.semibold,
                fontSize: 9,
                letterSpacing: 1.8,
                textAlign: 'center',
              }}
            >
              {modeLabel(mode, playing, buffering)}
            </Text>
          </View>

          <View style={{ width: '100%', alignItems: 'center', gap: compact ? 8 : 10 }}>
            <Text
              accessibilityRole="header"
              numberOfLines={3}
              style={{
                maxWidth: compact ? 340 : 680,
                color: theme.colors.ink,
                fontFamily: theme.fonts.display,
                fontSize: compact ? 42 : 58,
                lineHeight: compact ? 45 : 61,
                letterSpacing: compact ? -1.2 : -1.8,
                textAlign: 'center',
              }}
            >
              {episode.title}
            </Text>
            <Text
              numberOfLines={1}
              style={{
                maxWidth: compact ? 300 : 540,
                color: theme.colors.muted,
                fontFamily: theme.fonts.medium,
                fontSize: compact ? 12 : 14,
                textAlign: 'center',
              }}
            >
              {episode.podcastTitle}
            </Text>
          </View>

          {adSkipAvailable ? (
            <View
              accessibilityLabel={`Sponsored segment is active${sponsoredRemaining === undefined ? '' : `, ${formatDuration(sponsoredRemaining)} remaining`}`}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                paddingVertical: 8,
                paddingHorizontal: 13,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: 'rgba(233,162,103,0.28)',
                backgroundColor: 'rgba(233,112,95,0.1)',
              }}
            >
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: theme.colors.coral,
                  boxShadow: '0 0 16px rgba(233,162,103,0.5)',
                }}
              />
              <Text
                style={{
                  color: theme.colors.coral,
                  fontFamily: theme.fonts.semibold,
                  fontSize: 9,
                  letterSpacing: 1.25,
                }}
              >
                SAY “SKIP AD”
                {sponsoredRemaining === undefined ? '' : ` · ${formatDuration(sponsoredRemaining)}`}
              </Text>
            </View>
          ) : null}
        </View>

        <View style={{ width: '100%', alignItems: 'center', gap: compact ? 18 : 22 }}>
          {playbackIssue ? (
            <View
              accessibilityLiveRegion="polite"
              style={{
                width: '100%',
                maxWidth: 430,
                alignItems: 'center',
                gap: 10,
                padding: 16,
                borderRadius: 24,
                borderCurve: 'continuous',
                borderWidth: 1,
                borderColor:
                  playbackIssue === 'error'
                    ? 'rgba(233,162,103,0.3)'
                    : 'rgba(114,198,168,0.24)',
                backgroundColor:
                  playbackIssue === 'error'
                    ? 'rgba(233,162,103,0.08)'
                    : 'rgba(114,198,168,0.07)',
              }}
            >
              <Text
                style={{
                  color: theme.colors.ink,
                  fontFamily: theme.fonts.semibold,
                  fontSize: 12,
                  textAlign: 'center',
                }}
              >
                {playbackIssue === 'error' ? 'Playback needs attention.' : 'Episode finished.'}
              </Text>
              <Pressable
                accessibilityLabel={
                  playbackIssue === 'error' ? 'Retry episode playback' : 'Replay episode'
                }
                accessibilityRole="button"
                onPress={onRetryPlayback}
                style={({ pressed }) => ({
                  minHeight: 42,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  paddingHorizontal: 14,
                  borderRadius: 22,
                  backgroundColor: theme.colors.ink,
                  opacity: pressed ? 0.66 : 1,
                })}
              >
                <Feather
                  name={playbackIssue === 'error' ? 'refresh-cw' : 'rotate-ccw'}
                  size={14}
                  color={theme.colors.canvas}
                />
                <Text
                  style={{
                    color: theme.colors.canvas,
                    fontFamily: theme.fonts.semibold,
                    fontSize: 9,
                    letterSpacing: 1,
                  }}
                >
                  {playbackIssue === 'error' ? 'TRY AGAIN' : 'REPLAY'}
                </Text>
              </Pressable>
            </View>
          ) : null}

          <Pressable
            accessibilityHint="Pauses the podcast, opens the microphone, and keeps this playback position."
            accessibilityLabel="Ask Murmur about this podcast"
            accessibilityRole="button"
            accessibilityState={{ busy: voiceBusy, disabled: primaryDisabled }}
            disabled={primaryDisabled}
            onPress={onMicPress}
            style={({ pressed }) => ({
              width: compact ? 116 : 132,
              height: compact ? 116 : 132,
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: voiceBusy ? 'rgba(233,162,103,0.52)' : 'rgba(246,242,233,0.16)',
              backgroundColor: voiceBusy ? 'rgba(233,162,103,0.18)' : 'rgba(246,242,233,0.92)',
              boxShadow: voiceBusy
                ? '0 0 54px rgba(233,111,132,0.24)'
                : '0 20px 70px rgba(0,0,0,0.38)',
              opacity: primaryDisabled ? 0.45 : pressed ? 0.7 : 1,
              transform: [{ scale: pressed ? 0.97 : 1 }],
            })}
          >
            <Feather
              name={mode === 'listening' ? 'square' : 'mic'}
              size={compact ? 31 : 36}
              color={voiceBusy ? theme.colors.coral : theme.colors.canvas}
            />
            <Text
              numberOfLines={1}
              style={{
                color: voiceBusy ? theme.colors.coral : theme.colors.canvas,
                fontFamily: theme.fonts.semibold,
                fontSize: 9,
                letterSpacing: 1.05,
                textAlign: 'center',
              }}
            >
              {mode === 'listening' ? 'DONE' : 'ASK'}
            </Text>
          </Pressable>

          <Text
            accessibilityLiveRegion="polite"
            style={{
              maxWidth: compact ? 300 : 420,
              color: theme.colors.subtle,
              fontFamily: theme.fonts.medium,
              fontSize: 10,
              lineHeight: 16,
              letterSpacing: 0.45,
              textAlign: 'center',
            }}
          >
            {wakeWordStatus === 'ready'
              ? 'SAY “HEY MURMUR” TO INTERRUPT'
              : wakeWordStatus === 'arming'
                ? 'ENABLING “HEY MURMUR”…'
                : `${formatDuration(currentTime)} elapsed · ${formatDuration(timeRemaining)} left`}
          </Text>
        </View>
      </View>
    </View>
  );
}
