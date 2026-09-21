import Feather from '@expo/vector-icons/Feather';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BrandLockup } from '@/components/brand-lockup';
import { MurmurIconButton } from '@/components/murmur-icon-button';
import type { AppTheme } from '@/design/tokens';
import type { CatalogEpisode } from '@/domain/podcast';
import { AmbientPodcastRail } from '@/features/home/ambient-podcast-rail';
import {
  VoiceAura,
  type VoiceAuraPhase,
  type VoiceAuraVisualState,
} from '@/features/home/voice-aura';

export type ImmersiveDiscoveryPhase = VoiceAuraPhase;
export type ImmersiveDiscoveryCatalogStatus = 'loading' | 'ready' | 'error';

export type ImmersiveDiscoveryStageProps = {
  catalogErrorMessage?: string;
  catalogStatus: ImmersiveDiscoveryCatalogStatus;
  backgroundEpisode?: CatalogEpisode;
  episodes: readonly CatalogEpisode[];
  errorKind?: 'podcast-search' | 'voice';
  /** A short time-aware greeting. Used when no more specific idle title is supplied. */
  greeting?: string;
  /** Personalized prompt rendered inside the aura before recording starts. */
  idleTitle?: string;
  idleSubtitle?: string;
  /** Prepared listening can start independently of the ambient podcast catalog. */
  requiresCatalog?: boolean;
  message?: string;
  metering?: number | null;
  onCancel: () => void;
  onOpenSettings?: () => void;
  onPrimaryPress: () => void;
  onRetryFeed: () => void;
  phase: ImmersiveDiscoveryPhase;
  reducedMotion: boolean;
  theme: AppTheme;
  response?: string;
  transcript?: string;
};

const meterShape = [0.14, 0.2, 0.3, 0.45, 0.68, 0.88, 1, 0.8, 0.6, 0.42, 0.29, 0.2, 0.14] as const;
const meterColors = [
  '#E66D67',
  '#EA6D70',
  '#EF6D7B',
  '#F06B88',
  '#F16A96',
  '#F169A6',
  '#F36BB8',
  '#E768B3',
  '#D963AD',
  '#C95EA6',
  '#B9589D',
  '#A45290',
  '#8D4C80',
] as const;

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function phaseTitle(
  phase: ImmersiveDiscoveryPhase,
  idleTitle: string | undefined,
  greeting: string | undefined,
  errorKind: ImmersiveDiscoveryStageProps['errorKind'],
) {
  if (phase === 'arming') return 'One moment.';
  if (phase === 'listening') return 'I’m listening.';
  if (phase === 'processing') return 'Following that…';
  if (phase === 'error') {
    return errorKind === 'podcast-search' ? 'Podcast unavailable.' : 'Voice unavailable.';
  }
  return idleTitle || greeting || 'Hey there.';
}

function primaryAccessibilityLabel(phase: ImmersiveDiscoveryPhase) {
  if (phase === 'arming') return 'Murmur is opening the microphone';
  if (phase === 'listening') return 'Finish speaking and send this request';
  if (phase === 'processing') return 'Murmur is processing this request';
  if (phase === 'error') return 'Try speaking to Murmur again';
  return 'Speak to Murmur';
}

function activityLabel({ catalogStatus, errorKind, phase }: {
  catalogStatus: ImmersiveDiscoveryCatalogStatus;
  errorKind: ImmersiveDiscoveryStageProps['errorKind'];
  phase: ImmersiveDiscoveryPhase;
}) {
  if (phase === 'arming') return 'OPENING MICROPHONE';
  if (phase === 'processing') return 'UNDERSTANDING';
  if (phase === 'error') {
    return errorKind === 'podcast-search' ? 'PODCAST UNAVAILABLE' : 'VOICE UNAVAILABLE';
  }
  if (catalogStatus === 'loading') return 'TUNING YOUR FEED';
  if (catalogStatus === 'error') return 'THE FEED IS QUIET';
  return 'LISTEN   EXPLORE   DISCOVER';
}

function latestTranscriptExcerpt(transcript: string, maximumCharacters = 50) {
  if (transcript.length <= maximumCharacters) return transcript;
  const excerpt = transcript.slice(-maximumCharacters);
  const firstWordBreak = excerpt.indexOf(' ');
  return `…${excerpt.slice(firstWordBreak > -1 ? firstWordBreak + 1 : 0)}`;
}

function VoiceMeterBar({
  index,
  level,
  reducedMotion,
  shape,
  visualState,
}: {
  index: number;
  level?: number;
  reducedMotion: boolean;
  shape: number;
  visualState: VoiceAuraVisualState;
}) {
  const pulse = useSharedValue(0);
  const normalizedLevel = level === undefined || !Number.isFinite(level)
    ? undefined
    : clamp(level);

  useEffect(() => {
    cancelAnimation(pulse);
    pulse.value = 0;

    if (reducedMotion || visualState === 'resting') return;

    pulse.value = withDelay(
      index * 38,
      withRepeat(
        withTiming(1, {
          duration: 480 + (index % 5) * 76,
          easing: Easing.inOut(Easing.sin),
        }),
        -1,
        true,
      ),
    );

    return () => cancelAnimation(pulse);
  }, [index, pulse, reducedMotion, visualState]);

  const animatedStyle = useAnimatedStyle(() => {
    const isResting = visualState === 'resting';
    const isTranscribing = visualState === 'transcribing';
    const voiceEnergy = isTranscribing ? (normalizedLevel ?? 0.42) : 0;
    const restingScale = 0.12 + shape * 0.18;
    const listeningScale = 0.27 + shape * 0.32;
    const transcriptionScale = 0.36 + shape * 0.36 + voiceEnergy * (0.16 + shape * 0.14);
    const baseScale = isResting
      ? restingScale
      : isTranscribing
        ? transcriptionScale
        : listeningScale;
    const motionScale = isResting ? 0 : pulse.value * (0.12 + shape * 0.16);

    return {
      opacity: isResting
        ? 0.22 + shape * 0.24
        : isTranscribing
          ? 0.5 + shape * 0.42
          : 0.34 + shape * 0.34,
      transform: [
        { scaleY: Math.min(1.18, baseScale + motionScale) },
        { scaleX: isTranscribing ? 1 + voiceEnergy * 0.08 : 1 },
      ],
    };
  });

  return (
    <Animated.View
      style={[
        {
          width: index === 6 ? 5 : 3,
          height: 32,
          borderRadius: 999,
          backgroundColor: meterColors[index] ?? '#F16A96',
          boxShadow: visualState === 'transcribing'
            ? `0 0 ${8 + Math.round((normalizedLevel ?? 0.42) * 12)}px ${meterColors[index] ?? '#F16A96'}`
            : undefined,
        },
        animatedStyle,
      ]}
    />
  );
}

function VoiceMeter({
  level,
  reducedMotion,
  visualState,
}: {
  level?: number;
  reducedMotion: boolean;
  visualState: VoiceAuraVisualState;
}) {

  return (
    <View
      accessible={false}
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        height: 34,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
      }}
    >
      {meterShape.map((shape, index) => (
        <VoiceMeterBar
          index={index}
          key={`${shape}-${index}`}
          level={level}
          reducedMotion={reducedMotion}
          shape={shape}
          visualState={visualState}
        />
      ))}
    </View>
  );
}

export function ImmersiveDiscoveryStage({
  catalogErrorMessage,
  catalogStatus,
  errorKind,
  backgroundEpisode,
  episodes,
  greeting,
  idleTitle,
  idleSubtitle = 'What would you like to listen to?',
  requiresCatalog = true,
  message,
  metering,
  onCancel,
  onOpenSettings,
  onPrimaryPress,
  onRetryFeed,
  phase,
  reducedMotion,
  theme,
  response,
  transcript = '',
}: ImmersiveDiscoveryStageProps) {
  const insets = useSafeAreaInsets();
  const { height, width } = useWindowDimensions();
  const [settingsVisible, setSettingsVisible] = useState(false);
  const compact = width < 640;
  const short = height < 700;
  const busy = phase === 'arming' || phase === 'processing';
  const listening = phase === 'listening';
  const settingsAvailable = phase === 'idle' || phase === 'error';
  const hasCatalog = catalogStatus === 'ready' && episodes.length > 0;
  const primaryDisabled = busy || (requiresCatalog && phase === 'idle' && !hasCatalog);
  const widthAuraLimit = width <= 430
    ? width * 0.86
    : Math.min(600, 361 + (width - 430) * 0.32);
  const heightAuraRatio = clamp(0.5 + ((width - 600) / 680) * 0.08, 0.5, 0.58);
  const auraSize = Math.round(Math.min(widthAuraLimit, height * heightAuraRatio, 600));
  const titleFontSize = Math.round(clamp(auraSize * (compact ? 0.077 : 0.09), 24, 42));
  const cleanedTranscript = transcript.trim();
  const cleanedResponse = response?.trim() ?? '';
  const title = phaseTitle(phase, idleTitle, greeting, errorKind);
  const showingTranscript = Boolean(
    cleanedTranscript &&
    !cleanedResponse &&
    (phase === 'listening' || phase === 'processing'),
  );
  const showingSystemResponse = Boolean(cleanedResponse);
  const displayTitle = showingSystemResponse ? latestTranscriptExcerpt(cleanedResponse, 112) : title;
  const transcriptExcerpt = latestTranscriptExcerpt(cleanedTranscript, 118);
  const speaking = listening && (
    cleanedTranscript.length > 0 ||
    (metering !== null && metering !== undefined && metering >= 0.25)
  );
  const auraVisualState: VoiceAuraVisualState = speaking
    ? 'transcribing'
    : phase === 'arming' || phase === 'listening' || phase === 'processing'
      ? 'listening'
      : 'resting';
  const visibleMessage = phase === 'error'
    ? message
    : phase === 'arming' || (phase === 'processing' && !cleanedTranscript && !cleanedResponse)
        ? message
        : undefined;
  const statusLabel = activityLabel({ catalogStatus, errorKind, phase });
  const subtitle = phase === 'idle'
    ? idleSubtitle
    : phase === 'listening' && !showingTranscript
      ? 'Go ahead.'
      : undefined;
  const compactHeroTop = Math.round(
    Math.max(insets.top + (short ? 104 : 126), height * (short ? 0.235 : 0.275)),
  );

  const railEpisodes = useMemo(() => episodes.slice(0, 8), [episodes]);

  const handlePrimaryPress = () => {
    onPrimaryPress();
  };

  const handleCancel = () => {
    onCancel();
  };

  const handleOpenSettings = () => {
    if (!settingsAvailable) return;

    if (process.env.EXPO_OS === 'web') {
      setSettingsVisible(true);
      return;
    }
    onOpenSettings?.();
  };

  return (
    <View
      style={{
        minHeight: height,
        flex: 1,
        overflow: 'hidden',
        backgroundColor: '#08090D',
      }}
    >
      <View
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          position: 'absolute',
          zIndex: 1,
          width: compact ? 300 : 640,
          height: compact ? 300 : 640,
          top: compact ? -165 : -390,
          right: compact ? -150 : -250,
          borderRadius: 999,
          backgroundColor: 'rgba(91,25,58,0.5)',
          boxShadow: compact ? '0 0 110px rgba(95,28,75,0.2)' : undefined,
          pointerEvents: 'none',
        }}
      />
      <View
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          position: 'absolute',
          zIndex: 1,
          width: compact ? width * 0.84 : 720,
          height: compact ? height * 0.54 : 620,
          top: compact ? height * 0.12 : 130,
          alignSelf: 'center',
          borderRadius: 999,
          backgroundColor: 'rgba(52,20,45,0.09)',
          boxShadow: compact
            ? '0 0 130px rgba(87,31,71,0.18)'
            : '0 0 180px rgba(87,31,71,0.16)',
          pointerEvents: 'none',
        }}
      />
      <View
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          position: 'absolute',
          zIndex: 1,
          right: 0,
          bottom: 0,
          left: 0,
          height: compact ? 260 : 480,
          overflow: 'hidden',
          pointerEvents: 'none',
        }}
      >
        <View
          style={{
            position: 'absolute',
            width: compact ? 260 : 480,
            height: compact ? 260 : 480,
            bottom: compact ? -130 : -310,
            left: compact ? -135 : -210,
            borderRadius: 999,
            backgroundColor: 'rgba(77,57,133,0.2)',
          }}
        />
      </View>

      {backgroundEpisode ? (
        <View
          aria-hidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 0,
            overflow: 'hidden',
            pointerEvents: 'none',
          }}
        >
          {backgroundEpisode.bundledArtworkSource || backgroundEpisode.artworkUrl ? (
            <Image
              source={backgroundEpisode.bundledArtworkSource ?? { uri: backgroundEpisode.artworkUrl }}
              contentFit="cover"
              transition={reducedMotion ? 0 : 420}
              style={{
                position: 'absolute',
                inset: -28,
                opacity: 0.38,
                transform: [{ scale: 1.08 }],
              }}
            />
          ) : null}
          <LinearGradient
            colors={[
              'rgba(8,9,11,0.58)',
              'rgba(8,9,11,0.82)',
              'rgba(8,9,11,0.96)',
            ]}
            locations={[0, 0.48, 1]}
            style={{ position: 'absolute', inset: 0 }}
          />
        </View>
      ) : railEpisodes.length ? (
        <AmbientPodcastRail
          episodes={railEpisodes}
          reducedMotion={reducedMotion}
          speed={14}
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            opacity: phase === 'error' ? 0.34 : phase === 'idle' ? 0.9 : 0.82,
          }}
        />
      ) : null}

      <View
        style={{
          zIndex: 3,
          width: '100%',
          maxWidth: 1180,
          alignSelf: 'center',
          paddingTop: Math.max(insets.top, compact ? 18 : 24) + (compact ? 10 : 12),
          paddingRight: Math.max(insets.right, compact ? 20 : 38),
          paddingLeft: Math.max(insets.left, compact ? 20 : 38),
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 18,
        }}
      >
        <BrandLockup
          gap={compact ? 7 : 12}
          markSize={compact ? 37 : 42}
          textSize={compact ? 13 : 14}
          theme={theme}
        />
        {onOpenSettings || process.env.EXPO_OS === 'web' ? (
          <MurmurIconButton
            accessibilityState={{ disabled: !settingsAvailable }}
            icon="settings"
            iconSize={compact ? 18 : 20}
            label={settingsAvailable ? 'Open settings' : 'Settings unavailable while recording'}
            onPress={handleOpenSettings}
            size={compact ? 42 : 52}
            theme={theme}
            style={{ backgroundColor: 'rgba(255,255,255,0.035)' }}
          />
        ) : null}
      </View>

      <View
        style={compact
          ? {
              position: 'absolute',
              zIndex: 2,
              top: compactHeroTop,
              right: 0,
              left: 0,
              alignItems: 'center',
              paddingHorizontal: Math.max(insets.left, insets.right, 12),
            }
          : {
              zIndex: 2,
              flex: 1,
              minHeight: 0,
              alignItems: 'center',
              justifyContent: 'center',
              paddingTop: 10,
              paddingRight: Math.max(insets.right, 18),
              paddingBottom: Math.max(insets.bottom, 230),
              paddingLeft: Math.max(insets.left, 18),
            }}
      >
        <VoiceAura
          accessibilityLabel={primaryAccessibilityLabel(phase)}
          disabled={primaryDisabled}
          metering={metering ?? undefined}
          onPress={handlePrimaryPress}
          phase={phase}
          reducedMotion={reducedMotion}
          size={auraSize}
          visualState={auraVisualState}
        >
          <Animated.View
            key={displayTitle}
            entering={reducedMotion ? undefined : FadeIn.duration(220)}
            exiting={reducedMotion ? undefined : FadeOut.duration(140)}
            style={{ width: '100%', alignItems: 'center', gap: 7 }}
          >
            {catalogStatus === 'loading' && phase === 'idle' ? (
              <ActivityIndicator color={theme.colors.coral} size="small" />
            ) : null}
            {showingSystemResponse ? (
              <Text
                style={{
                  color: 'rgba(246,242,233,0.58)',
                  fontFamily: theme.fonts.semibold,
                  fontSize: compact ? 8 : 9,
                  letterSpacing: 1.45,
                  textAlign: 'center',
                }}
              >
                MURMUR
              </Text>
            ) : null}
            <Text
              accessibilityLiveRegion="polite"
              ellipsizeMode={showingSystemResponse ? 'head' : 'tail'}
              numberOfLines={showingSystemResponse || phase === 'idle' ? 2 : 1}
              style={{
                maxWidth: auraSize * (showingSystemResponse ? 0.72 : phase === 'idle' ? 0.68 : 0.62),
                color: theme.colors.ink,
                fontFamily: theme.fonts.display,
                fontSize: showingSystemResponse ? Math.max(21, titleFontSize - 4) : titleFontSize,
                lineHeight:
                  (showingSystemResponse ? Math.max(21, titleFontSize - 4) : titleFontSize) +
                  (titleFontSize < 30 ? 5 : 6),
                letterSpacing: compact ? -0.65 : -1,
                textAlign: 'center',
              }}
            >
              {displayTitle}
            </Text>
            {subtitle ? (
              <Text
                numberOfLines={1}
                style={{
                  maxWidth: auraSize * 0.68,
                  color: 'rgba(246,242,233,0.66)',
                  fontFamily: theme.fonts.body,
                  fontSize: compact ? 13 : 15,
                  lineHeight: compact ? 18 : 21,
                  textAlign: 'center',
                }}
              >
                {subtitle}
              </Text>
            ) : null}
            {showingTranscript ? (
              <View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={{
                  width: compact ? 72 : 82,
                  height: compact ? 72 : 82,
                  marginTop: compact ? 5 : 8,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: 'rgba(239,116,161,0.42)',
                  backgroundColor: 'rgba(10,8,13,0.34)',
                  boxShadow: '0 0 34px rgba(255,82,157,0.18)',
                }}
              >
                <View
                  style={{
                    width: compact ? 50 : 58,
                    height: compact ? 50 : 58,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: 'rgba(246,242,233,0.1)',
                    backgroundColor: 'rgba(17,12,19,0.72)',
                  }}
                >
                  <View
                    style={{
                      width: compact ? 17 : 19,
                      height: compact ? 17 : 19,
                      borderRadius: 4,
                      backgroundColor: '#E96C9A',
                      boxShadow: '0 0 18px rgba(255,99,158,0.62)',
                    }}
                  />
                </View>
              </View>
            ) : null}
          </Animated.View>
        </VoiceAura>

        {showingTranscript ? (
          <Animated.View
            accessibilityLiveRegion="polite"
            entering={
              reducedMotion
                ? undefined
                : FadeIn.duration(220).easing(Easing.out(Easing.cubic))
            }
            exiting={
              reducedMotion
                ? undefined
                : FadeOut.duration(260).easing(Easing.inOut(Easing.cubic))
            }
            style={{
              width: '100%',
              maxWidth: compact ? Math.min(width - 48, 350) : 500,
              alignItems: 'center',
              gap: 7,
              marginTop: compact ? 16 : 18,
              paddingVertical: compact ? 12 : 14,
              paddingHorizontal: compact ? 16 : 20,
              borderRadius: 24,
              borderCurve: 'continuous',
              borderWidth: 1,
              borderColor: 'rgba(246,242,233,0.1)',
              backgroundColor: 'rgba(8,9,11,0.42)',
              boxShadow: '0 18px 60px rgba(0,0,0,0.28)',
            }}
          >
            <Text
              style={{
                color: 'rgba(246,242,233,0.5)',
                fontFamily: theme.fonts.semibold,
                fontSize: 8,
                letterSpacing: 1.5,
                textAlign: 'center',
              }}
            >
              YOU’RE SAYING
            </Text>
            <Text
              accessibilityLabel={cleanedTranscript}
              ellipsizeMode="head"
              numberOfLines={2}
              selectable
              style={{
                width: '100%',
                color: theme.colors.ink,
                fontFamily: theme.fonts.display,
                fontSize: compact ? 20 : 24,
                lineHeight: compact ? 26 : 31,
                letterSpacing: -0.45,
                textAlign: 'center',
              }}
            >
              {transcriptExcerpt}
            </Text>
          </Animated.View>
        ) : null}

        <View
          style={{
            alignItems: 'center',
            gap: 9,
            marginTop: compact ? 14 : 10,
          }}
        >
          <VoiceMeter
            level={metering ?? undefined}
            reducedMotion={reducedMotion}
            visualState={auraVisualState}
          />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 13 }}>
            {statusLabel === 'LISTEN   EXPLORE   DISCOVER' ? (
              <View
                style={{
                  width: compact ? 28 : 36,
                  height: 1,
                  backgroundColor: 'rgba(246,242,233,0.22)',
                }}
              />
            ) : null}
            <Text
              accessibilityLiveRegion="polite"
              style={{
                color: phase === 'error' ? theme.colors.coral : theme.colors.subtle,
                fontFamily: theme.fonts.semibold,
                fontSize: compact ? 9 : 9,
                letterSpacing: compact ? 2 : 2,
                textAlign: 'center',
                fontVariant: ['tabular-nums'],
              }}
            >
              {statusLabel}
            </Text>
            {statusLabel === 'LISTEN   EXPLORE   DISCOVER' ? (
              <View
                style={{
                  width: compact ? 28 : 36,
                  height: 1,
                  backgroundColor: 'rgba(246,242,233,0.22)',
                }}
              />
            ) : null}
          </View>

          {visibleMessage ? (
            <Text
              accessibilityLiveRegion={phase === 'error' ? 'assertive' : 'polite'}
              numberOfLines={phase === 'error' ? 3 : 2}
              selectable={phase === 'error'}
              style={{
                maxWidth: compact ? Math.min(width - 64, 420) : 520,
                color: phase === 'error' ? theme.colors.coral : theme.colors.muted,
                fontFamily: theme.fonts.body,
                fontSize: compact ? 11 : 12,
                lineHeight: compact ? 17 : 19,
                textAlign: 'center',
              }}
            >
              {visibleMessage}
            </Text>
          ) : null}

          {phase === 'idle' && catalogStatus === 'error' ? (
            <View style={{ alignItems: 'center', gap: 6 }}>
              {catalogErrorMessage ? (
                <Text
                  accessibilityLiveRegion="assertive"
                  numberOfLines={2}
                  selectable
                  style={{
                    maxWidth: compact ? width - 64 : 480,
                    color: theme.colors.muted,
                    fontFamily: theme.fonts.body,
                    fontSize: 11,
                    lineHeight: 17,
                    textAlign: 'center',
                  }}
                >
                  {catalogErrorMessage}
                </Text>
              ) : null}
              <Pressable
                accessibilityLabel="Retry the podcast feed"
                accessibilityRole="button"
                onPress={onRetryFeed}
                style={({ pressed }) => ({
                  minHeight: 44,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 7,
                  paddingHorizontal: 14,
                  borderRadius: 20,
                  borderWidth: 1,
                  borderColor: theme.colors.line,
                  backgroundColor: 'rgba(255,255,255,0.035)',
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <Feather name="refresh-cw" size={13} color={theme.colors.coral} />
                <Text
                  style={{
                    color: theme.colors.ink,
                    fontFamily: theme.fonts.semibold,
                    fontSize: 9,
                    letterSpacing: 1.2,
                  }}
                >
                  RETRY FEED
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </View>

      {phase !== 'idle' ? (
        <Animated.View
          entering={reducedMotion ? undefined : FadeIn.duration(180)}
          exiting={reducedMotion ? undefined : FadeOut.duration(120)}
          style={{
            position: 'absolute',
            zIndex: 4,
            right: 0,
            bottom: Math.max(insets.bottom + 52, 86),
            left: 0,
            alignItems: 'center',
            pointerEvents: 'box-none',
          }}
        >
          <MurmurIconButton
            icon="x"
            label={phase === 'error' ? 'Dismiss voice error' : 'Cancel voice request'}
            onPress={handleCancel}
            size={56}
            iconSize={22}
            theme={theme}
            style={{
              backgroundColor: 'rgba(13,14,18,0.9)',
              boxShadow: '0 18px 44px rgba(0,0,0,0.42)',
            }}
          />
        </Animated.View>
      ) : null}

      <Modal
        animationType={reducedMotion ? 'none' : 'fade'}
        onRequestClose={() => setSettingsVisible(false)}
        transparent
        visible={settingsVisible}
      >
        <View
          accessibilityViewIsModal
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            backgroundColor: 'rgba(5,5,8,0.78)',
          }}
        >
          <Pressable
            accessible={false}
            aria-hidden
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            onPress={() => setSettingsVisible(false)}
            style={{ position: 'absolute', inset: 0 }}
          />
          <View
            style={{
              width: '100%',
              maxWidth: 420,
              gap: 16,
              padding: compact ? 24 : 30,
              borderRadius: 28,
              borderCurve: 'continuous',
              borderWidth: 1,
              borderColor: theme.colors.line,
              backgroundColor: theme.colors.surfaceStrong,
              boxShadow: theme.shadow,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 18,
              }}
            >
              <Text
                accessibilityRole="header"
                style={{
                  color: theme.colors.ink,
                  fontFamily: theme.fonts.display,
                  fontSize: 28,
                }}
              >
                Voice settings
              </Text>
              <MurmurIconButton
                icon="x"
                iconSize={18}
                label="Close voice settings"
                onPress={() => setSettingsVisible(false)}
                size={44}
                theme={theme}
              />
            </View>
            <Text
              style={{
                color: theme.colors.muted,
                fontFamily: theme.fonts.body,
                fontSize: 13,
                lineHeight: 21,
              }}
            >
              Microphone access is managed by your browser. Use the site controls beside the
              address bar to allow Murmur, then tap the aura again.
            </Text>
          </View>
        </View>
      </Modal>
    </View>
  );
}
