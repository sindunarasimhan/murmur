import Feather from '@expo/vector-icons/Feather';
import { LinearGradient } from 'expo-linear-gradient';
import type { ComponentProps } from 'react';
import { useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { AppTheme } from '@/design/tokens';
import { useReducedMotion } from '@/design/use-reduced-motion';

export type VoiceTakeoverPhase =
  | 'welcome'
  | 'arming'
  | 'listening'
  | 'processing'
  | 'speaking'
  | 'exploring'
  | 'error';

export type VoiceTakeoverCopy = {
  title: string;
  description?: string;
};

export type VoiceTakeoverProps = {
  /** A short context line, such as an episode title or a discovery cue. */
  contextLabel?: string;
  /** Personalized copy shown before recording starts. */
  welcome: VoiceTakeoverCopy;
  visible: boolean;
  phase: VoiceTakeoverPhase;
  theme: AppTheme;
  transcript?: string;
  response?: string;
  activityMessage?: string;
  errorMessage?: string;
  /** Lets either surface tailor state copy without duplicating the takeover. */
  phaseCopy?: Partial<Record<VoiceTakeoverPhase, VoiceTakeoverCopy>>;
  primaryLabel?: string;
  primaryDisabled?: boolean;
  recordingDurationMillis?: number;
  /** Expo-style decibels (-160...0) or a normalized microphone level (0...1). */
  metering?: number;
  reducedMotion?: boolean;
  onPrimaryPress: () => void;
  onClose: () => void;
  /** Optional explicit handoff from Murmur back to publisher audio. */
  onReturnToEpisode?: () => void;
  returnToEpisodeLabel?: string;
};

type FeatherName = ComponentProps<typeof Feather>['name'];

const defaultPhaseCopy: Record<VoiceTakeoverPhase, VoiceTakeoverCopy> = {
  welcome: { title: '', description: '' },
  arming: {
    title: 'One moment.',
    description: 'Opening the microphone…',
  },
  listening: {
    title: 'I’m listening.',
    description: 'Say what you want, then tap when you’re finished.',
  },
  processing: {
    title: 'Following your thought.',
    description: 'Connecting what you said to the moment that brought you here.',
  },
  speaking: {
    title: 'Here’s the thread.',
    description: 'Murmur is speaking. The podcast remains paused at your saved place.',
  },
  exploring: {
    title: 'Where should we go next?',
    description: 'Ask a follow-up or return to the podcast when you’re ready.',
  },
  error: {
    title: 'Let’s try that again.',
    description: 'Your place is still here.',
  },
};

const energyShape = [0.42, 0.68, 0.84, 1, 0.76, 0.92, 0.58, 0.72, 0.38] as const;

function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeMetering(metering?: number): number | undefined {
  if (metering === undefined || !Number.isFinite(metering)) return undefined;
  if (metering < 0) return clamp((metering + 60) / 60);
  if (metering <= 1) return metering;
  return clamp(metering / 100);
}

function formatRecordingTime(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function stateLabel(phase: VoiceTakeoverPhase) {
  if (phase === 'welcome') return 'VOICE';
  if (phase === 'arming') return 'GETTING READY';
  if (phase === 'listening') return 'LISTENING';
  if (phase === 'processing') return 'THINKING';
  if (phase === 'speaking') return 'MURMUR SPEAKING';
  if (phase === 'exploring') return 'MURMUR · YOUR TURN';
  return 'NEEDS YOUR ATTENTION';
}

function primaryAction(phase: VoiceTakeoverPhase) {
  if (phase === 'listening') {
    return { icon: 'square' as const, label: 'I’M DONE', accessibilityLabel: 'Stop recording' };
  }
  if (phase === 'speaking') {
    return {
      icon: 'mic' as const,
      label: 'INTERRUPT',
      accessibilityLabel: 'Interrupt Murmur and ask another question',
    };
  }
  if (phase === 'exploring') {
    return {
      icon: 'mic' as const,
      label: 'ASK ANOTHER',
      accessibilityLabel: 'Ask Murmur another question',
    };
  }
  if (phase === 'error') {
    return { icon: 'mic' as const, label: 'TRY AGAIN', accessibilityLabel: 'Try voice again' };
  }
  return { icon: 'mic' as const, label: 'START TALKING', accessibilityLabel: 'Start recording' };
}

function latestTranscriptExcerpt(transcript: string, maximumCharacters = 96) {
  if (transcript.length <= maximumCharacters) return transcript;
  const excerpt = transcript.slice(-maximumCharacters);
  const firstWordBreak = excerpt.indexOf(' ');
  return `…${excerpt.slice(firstWordBreak > -1 ? firstWordBreak + 1 : 0)}`;
}

function SecondaryAction({
  accessibilityLabel,
  emphasized = false,
  icon,
  label,
  onPress,
  theme,
}: {
  accessibilityLabel: string;
  emphasized?: boolean;
  icon: FeatherName;
  label: string;
  onPress: () => void;
  theme: AppTheme;
}) {
  const foreground = emphasized ? theme.colors.canvas : theme.colors.ink;

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        minWidth: 0,
        maxWidth: 230,
        minHeight: 46,
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingHorizontal: 14,
        borderRadius: 24,
        borderCurve: 'continuous',
        borderWidth: emphasized ? 0 : 1,
        borderColor: theme.colors.line,
        backgroundColor: emphasized ? theme.colors.ink : 'rgba(255,255,255,0.045)',
        opacity: pressed ? 0.62 : 1,
        transform: [{ scale: pressed ? 0.98 : 1 }],
      })}
    >
      <Feather name={icon} size={15} color={foreground} />
      <Text
        numberOfLines={1}
        style={{
          flexShrink: 1,
          color: foreground,
          fontFamily: theme.fonts.semibold,
          fontSize: 10,
          letterSpacing: 0.7,
        }}
      >
        {label.toUpperCase()}
      </Text>
    </Pressable>
  );
}

function EnergyMeter({
  level,
  reducedMotion,
  theme,
}: {
  level?: number;
  reducedMotion: boolean;
  theme: AppTheme;
}) {
  const hasLevel = level !== undefined;
  const visibleLevel = level ?? 0;
  const activeSegments = Math.ceil(visibleLevel * energyShape.length);

  return (
    <View
      accessible
      accessibilityLabel={
        hasLevel ? `Microphone level ${Math.round(visibleLevel * 100)} percent` : 'Microphone active'
      }
      accessibilityRole={hasLevel ? 'progressbar' : 'text'}
      accessibilityValue={
        hasLevel
          ? { min: 0, max: 100, now: Math.round(visibleLevel * 100) }
          : undefined
      }
      style={{ alignItems: 'center', gap: 7 }}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          height: reducedMotion ? 8 : 30,
          flexDirection: 'row',
          alignItems: reducedMotion ? 'center' : 'flex-end',
          justifyContent: 'center',
          gap: reducedMotion ? 4 : 5,
        }}
      >
        {energyShape.map((shape, index) => {
          const responsiveHeight = 5 + Math.round(25 * clamp(visibleLevel * (0.56 + shape * 0.62)));
          const segmentActive = hasLevel && index < activeSegments;
          return (
            <View
              key={`${shape}-${index}`}
              style={{
                width: reducedMotion ? 16 : 4,
                height: reducedMotion ? 4 : responsiveHeight,
                borderRadius: 999,
                backgroundColor: theme.colors.coral,
                opacity: hasLevel
                  ? reducedMotion
                    ? segmentActive
                      ? 0.95
                      : 0.18
                    : 0.38 + visibleLevel * 0.62
                  : 0.24,
              }}
            />
          );
        })}
      </View>
      <Text
        style={{
          color: theme.colors.subtle,
          fontFamily: theme.fonts.semibold,
          fontSize: 9,
          letterSpacing: 1.4,
        }}
      >
        {hasLevel ? 'VOICE LEVEL' : 'MICROPHONE ACTIVE'}
      </Text>
    </View>
  );
}

export function VoiceTakeover({
  contextLabel,
  welcome,
  visible,
  phase,
  theme,
  transcript = '',
  response,
  activityMessage,
  errorMessage,
  phaseCopy,
  primaryLabel,
  primaryDisabled = false,
  recordingDurationMillis = 0,
  metering,
  reducedMotion,
  onPrimaryPress,
  onClose,
  onReturnToEpisode,
  returnToEpisodeLabel = 'Return to episode',
}: VoiceTakeoverProps) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const contentScrollRef = useRef<ScrollView>(null);
  const systemReducedMotion = useReducedMotion();
  const shouldReduceMotion = reducedMotion ?? systemReducedMotion;
  const pulse = useSharedValue(0);
  const energy = useSharedValue(0);
  const compact = width < 640;
  const short = height < 700 || (compact && height < 880);
  const narrow = width < 360;
  const busy = phase === 'arming' || phase === 'processing';
  const listening = phase === 'listening';
  const showingResponse = phase === 'speaking' || phase === 'exploring';
  const meterLevel = normalizeMetering(metering);
  const hasMetering = meterLevel !== undefined;
  const currentCopy = phase === 'welcome'
    ? welcome
    : {
        ...defaultPhaseCopy[phase],
        ...phaseCopy?.[phase],
      };
  const primary = primaryAction(phase);
  const showPrimary = !busy;
  const feedback = phase === 'error' ? errorMessage || activityMessage : activityMessage;
  const hasSecondaryActions = Boolean(onReturnToEpisode);
  const displayTranscript = latestTranscriptExcerpt(transcript.trim());

  useEffect(() => {
    if (!visible || shouldReduceMotion || (listening && hasMetering)) {
      cancelAnimation(pulse);
      pulse.value = 0;
      return;
    }

    const duration = listening ? 1050 : busy ? 1450 : 2200;
    pulse.value = withRepeat(
      withTiming(1, { duration, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );

    return () => cancelAnimation(pulse);
  }, [busy, hasMetering, listening, pulse, shouldReduceMotion, visible]);

  useEffect(() => {
    cancelAnimation(energy);
    if (!visible || meterLevel === undefined) {
      energy.value = 0;
      return;
    }
    energy.value = shouldReduceMotion
      ? meterLevel
      : withTiming(meterLevel, { duration: 120, easing: Easing.out(Easing.quad) });
  }, [energy, meterLevel, shouldReduceMotion, visible]);

  useEffect(() => {
    if (!visible || !response) return;
    const timer = setTimeout(() => contentScrollRef.current?.scrollTo({ y: 0, animated: false }), 0);
    return () => clearTimeout(timer);
  }, [response, visible]);

  useEffect(() => {
    if (!visible) return;

    let cancelled = false;
    let announcementTimer: ReturnType<typeof setTimeout> | undefined;
    const announcement =
      phase === 'error'
        ? `${currentCopy.title} ${errorMessage || activityMessage || currentCopy.description || ''}`
        : phase === 'speaking'
          ? 'Murmur is speaking. The podcast is paused.'
          : phase === 'exploring'
            ? 'Murmur finished speaking. Ask a follow-up or return to the podcast.'
            : `${currentCopy.title} ${currentCopy.description || ''}`;

    void AccessibilityInfo.isScreenReaderEnabled().then((screenReaderEnabled) => {
      if (!screenReaderEnabled || cancelled) return;
      announcementTimer = setTimeout(() => {
        AccessibilityInfo.announceForAccessibility(announcement.trim());
      }, 180);
    });

    return () => {
      cancelled = true;
      if (announcementTimer) clearTimeout(announcementTimer);
    };
  }, [activityMessage, currentCopy.description, currentCopy.title, errorMessage, phase, visible]);

  const outerRingStyle = useAnimatedStyle(() => {
    if (shouldReduceMotion) return { opacity: listening ? 0.38 : 0.18, transform: [{ scale: 1 }] };
    const liveEnergy = listening && hasMetering ? energy.value : pulse.value;
    return {
      opacity: 0.12 + liveEnergy * (listening ? 0.34 : 0.14),
      transform: [{ scale: 1 + liveEnergy * (listening ? 0.1 : 0.05) }],
    };
  });
  const innerRingStyle = useAnimatedStyle(() => {
    if (shouldReduceMotion) return { opacity: 0.4, transform: [{ scale: 1 }] };
    const liveEnergy = listening && hasMetering ? energy.value : pulse.value;
    return {
      opacity: 0.3 + liveEnergy * 0.24,
      transform: [{ scale: 1 + liveEnergy * 0.035 }],
    };
  });

  return (
    <Modal
      accessibilityViewIsModal
      animationType={shouldReduceMotion ? 'none' : 'fade'}
      hardwareAccelerated
      onRequestClose={onClose}
      presentationStyle="fullScreen"
      statusBarTranslucent
      visible={visible}
    >
      <View
        style={{
          flex: 1,
          width: '100%',
          height,
          maxHeight: height,
          overflow: 'hidden',
          backgroundColor: '#08090B',
        }}
      >
        <LinearGradient
          colors={['#171116', '#090A0D', '#08090B']}
          locations={[0, 0.45, 1]}
          start={{ x: 0.05, y: 0 }}
          end={{ x: 0.9, y: 1 }}
          style={{ position: 'absolute', inset: 0 }}
        />
        <View
          style={{
            position: 'absolute',
            pointerEvents: 'none',
            width: compact ? 310 : 540,
            height: compact ? 310 : 540,
            top: compact ? -160 : -300,
            right: compact ? -150 : -190,
            borderRadius: 999,
            backgroundColor: theme.colors.coralWash,
            opacity: 0.78,
          }}
        />
        <View
          style={{
            position: 'absolute',
            pointerEvents: 'none',
            width: compact ? 250 : 430,
            height: compact ? 250 : 430,
            bottom: compact ? -150 : -250,
            left: compact ? -130 : -160,
            borderRadius: 999,
            backgroundColor: theme.colors.violetWash,
            opacity: 0.62,
          }}
        />

        <View
          style={{
            zIndex: 2,
            paddingTop: Math.max(insets.top, 16),
            paddingRight: Math.max(insets.right, compact ? 18 : 40),
            paddingBottom: 10,
            paddingLeft: Math.max(insets.left, compact ? 18 : 40),
            borderBottomWidth: 1,
            borderBottomColor: 'rgba(246,242,233,0.07)',
            backgroundColor: 'rgba(8,9,11,0.88)',
          }}
        >
          <View
            style={{
              width: '100%',
              maxWidth: 760,
              minHeight: 48,
              alignSelf: 'center',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
            }}
          >
            <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor:
                    phase === 'error'
                      ? theme.colors.coral
                      : listening
                        ? theme.colors.success
                        : phase === 'speaking' || phase === 'exploring'
                          ? '#BDAEF4'
                          : theme.colors.gold,
                }}
              />
              <Text
                accessibilityLiveRegion="polite"
                numberOfLines={1}
                style={{
                  flexShrink: 1,
                  color: theme.colors.muted,
                  fontFamily: theme.fonts.semibold,
                  fontSize: 10,
                  letterSpacing: 1.6,
                }}
              >
                {stateLabel(phase)}
                {listening && recordingDurationMillis > 0
                  ? ` · ${formatRecordingTime(recordingDurationMillis)}`
                  : ''}
              </Text>
            </View>

            <Pressable
              accessibilityHint="Cancels this interaction and restores your saved place."
              accessibilityLabel="Close voice experience"
              accessibilityRole="button"
              hitSlop={10}
              onPress={onClose}
              style={({ pressed }) => ({
                width: 48,
                height: 48,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 24,
                borderWidth: 1,
                borderColor: theme.colors.line,
                backgroundColor: 'rgba(255,255,255,0.035)',
                opacity: pressed ? 0.55 : 1,
                transform: [{ scale: pressed ? 0.96 : 1 }],
              })}
            >
              <Feather name="x" size={20} color={theme.colors.ink} />
            </Pressable>
          </View>
        </View>

        <ScrollView
          ref={contentScrollRef}
          alwaysBounceVertical={false}
          bounces={false}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          style={{ flex: 1, minHeight: 0 }}
          contentContainerStyle={{
            flexGrow: 1,
            alignItems: 'center',
            justifyContent: showingResponse ? 'flex-start' : 'center',
            paddingTop: short ? 18 : compact ? 26 : 38,
            paddingRight: Math.max(insets.right, compact ? 22 : 40),
            paddingBottom: short ? 18 : compact ? 28 : 42,
            paddingLeft: Math.max(insets.left, compact ? 22 : 40),
          }}
        >
          <View
            style={{
              width: '100%',
              maxWidth: 680,
              alignItems: 'center',
              gap: short ? 18 : compact ? 24 : 30,
            }}
          >
            <View style={{ width: '100%', alignItems: 'center', gap: compact ? 12 : 16 }}>
              {contextLabel ? (
                <Text
                  numberOfLines={2}
                  style={{
                    maxWidth: 560,
                    color: theme.colors.coral,
                    fontFamily: theme.fonts.semibold,
                    fontSize: 10,
                    lineHeight: 16,
                    letterSpacing: 1.8,
                    textAlign: 'center',
                  }}
                >
                  {contextLabel.toUpperCase()}
                </Text>
              ) : null}

              <Text
                accessibilityRole="header"
                style={{
                  width: '100%',
                  maxWidth: 660,
                  color: theme.colors.ink,
                  fontFamily: theme.fonts.display,
                  fontSize: short ? 35 : compact ? (showingResponse ? 40 : 46) : 60,
                  lineHeight: short ? 39 : compact ? (showingResponse ? 44 : 50) : 64,
                  letterSpacing: compact ? -1.1 : -1.7,
                  textAlign: 'center',
                }}
              >
                {currentCopy.title}
              </Text>

              {currentCopy.description ? (
                <Text
                  style={{
                    width: '100%',
                    maxWidth: 570,
                    color: theme.colors.muted,
                    fontFamily: theme.fonts.body,
                    fontSize: compact ? 13 : 15,
                    lineHeight: compact ? 21 : 24,
                    textAlign: 'center',
                  }}
                >
                  {currentCopy.description}
                </Text>
              ) : null}
            </View>

            {transcript.trim() ? (
              <View
                accessibilityLiveRegion="polite"
                style={{
                  width: '100%',
                  maxWidth: 620,
                  gap: 7,
                  paddingTop: 18,
                  borderTopWidth: 1,
                  borderTopColor: theme.colors.line,
                }}
              >
                <Text
                  style={{
                    color: theme.colors.subtle,
                    fontFamily: theme.fonts.semibold,
                    fontSize: 9,
                    letterSpacing: 1.7,
                    textAlign: showingResponse ? 'left' : 'center',
                  }}
                >
                  {listening ? 'HEARING' : 'YOU ASKED'}
                </Text>
                <Text
                  accessibilityLabel={transcript.trim()}
                  ellipsizeMode="head"
                  numberOfLines={2}
                  selectable
                  style={{
                    color: theme.colors.ink,
                    fontFamily: showingResponse ? theme.fonts.body : theme.fonts.display,
                    fontSize: showingResponse ? 14 : compact ? 21 : 25,
                    lineHeight: showingResponse ? 22 : compact ? 28 : 32,
                    textAlign: showingResponse ? 'left' : 'center',
                  }}
                >
                  {displayTranscript}
                </Text>
              </View>
            ) : listening ? (
              <Text
                accessibilityLiveRegion="polite"
                style={{
                  color: theme.colors.subtle,
                  fontFamily: theme.fonts.body,
                  fontSize: 12,
                  lineHeight: 19,
                  textAlign: 'center',
                }}
              >
                Your words will appear here.
              </Text>
            ) : null}

            {showingResponse && response ? (
              <View
                accessibilityLabel="Murmur response. The podcast is paused."
                accessibilityLiveRegion="polite"
                style={{
                  width: '100%',
                  maxWidth: 640,
                  gap: 13,
                  padding: compact ? 18 : 22,
                  borderRadius: 24,
                  borderCurve: 'continuous',
                  borderWidth: 1,
                  borderColor: 'rgba(189,174,244,0.24)',
                  backgroundColor: 'rgba(114,91,172,0.12)',
                }}
              >
                <View
                  style={{
                    flexDirection: 'row',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                    <View
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: '#BDAEF4',
                      }}
                    />
                    <Text
                      style={{
                        color: '#D4C8FF',
                        fontFamily: theme.fonts.semibold,
                        fontSize: 9,
                        letterSpacing: 1.45,
                      }}
                    >
                      MURMUR · GENERATED RESPONSE
                    </Text>
                  </View>
                  <Text
                    style={{
                      color: theme.colors.subtle,
                      fontFamily: theme.fonts.semibold,
                      fontSize: 9,
                      letterSpacing: 1.25,
                    }}
                  >
                    PODCAST PAUSED
                  </Text>
                </View>
                <Text
                  selectable
                  style={{
                    color: theme.colors.ink,
                    fontFamily: theme.fonts.body,
                    fontSize: compact ? 15 : 17,
                    lineHeight: compact ? 24 : 27,
                    textAlign: 'left',
                  }}
                >
                  {response}
                </Text>
              </View>
            ) : null}

            {feedback ? (
              <Text
                accessibilityLiveRegion="assertive"
                selectable={phase === 'error'}
                style={{
                  maxWidth: 570,
                  color: phase === 'error' ? theme.colors.coral : theme.colors.muted,
                  fontFamily: theme.fonts.medium,
                  fontSize: 12,
                  lineHeight: 19,
                  textAlign: 'center',
                }}
              >
                {feedback}
              </Text>
            ) : null}
          </View>
        </ScrollView>

        <View
          style={{
            zIndex: 2,
            paddingTop: short ? 10 : 14,
            paddingRight: Math.max(insets.right, compact ? 18 : 40),
            paddingBottom: Math.max(insets.bottom, compact ? 64 : short ? 10 : 16),
            paddingLeft: Math.max(insets.left, compact ? 18 : 40),
            borderTopWidth: 1,
            borderTopColor: 'rgba(246,242,233,0.09)',
            backgroundColor: 'rgba(8,9,11,0.94)',
          }}
        >
          <View
            style={{
              width: '100%',
              maxWidth: 620,
              alignSelf: 'center',
              alignItems: 'center',
              gap: short ? 8 : 12,
            }}
          >
            {listening ? (
              <EnergyMeter
                level={meterLevel}
                reducedMotion={shouldReduceMotion}
                theme={theme}
              />
            ) : null}

            {phase !== 'error' || !hasSecondaryActions ? (
            <View
              style={{
                width: short ? 112 : compact ? 134 : 142,
                height: short ? 112 : compact ? 134 : 142,
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
                    pointerEvents: 'none',
                    inset: 0,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: listening ? theme.colors.coral : theme.colors.line,
                    backgroundColor: listening ? theme.colors.coralWash : 'transparent',
                  },
                  outerRingStyle,
                ]}
              />
              <Animated.View
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[
                  {
                    position: 'absolute',
                    pointerEvents: 'none',
                    inset: short ? 12 : 15,
                    borderRadius: 999,
                    borderWidth: 1,
                    borderColor: listening
                      ? 'rgba(233,162,103,0.54)'
                      : 'rgba(246,242,233,0.16)',
                  },
                  innerRingStyle,
                ]}
              />
              {showPrimary ? (
                <Pressable
                  accessibilityHint={
                    listening
                      ? 'Finishes recording and sends what you said to Murmur.'
                      : phase === 'speaking'
                        ? 'Stops Murmur and opens the microphone.'
                        : 'Begins a voice interaction with Murmur.'
                  }
                  accessibilityLabel={primary.accessibilityLabel}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: primaryDisabled }}
                  disabled={primaryDisabled}
                  onPress={onPrimaryPress}
                  style={({ pressed }) => ({
                    width: short ? 88 : compact ? 100 : 108,
                    height: short ? 88 : compact ? 100 : 108,
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 7,
                    borderRadius: 999,
                    backgroundColor: listening ? theme.colors.coral : theme.colors.ink,
                    boxShadow: listening
                      ? '0 18px 54px rgba(233,162,103,0.26)'
                      : '0 18px 54px rgba(0,0,0,0.4)',
                    opacity: primaryDisabled ? 0.4 : pressed ? 0.72 : 1,
                    transform: [{ scale: pressed ? 0.97 : 1 }],
                  })}
                >
                  <Feather
                    name={primary.icon}
                    size={short ? 24 : 27}
                    color={theme.colors.canvas}
                  />
                  <Text
                    numberOfLines={1}
                    style={{
                      maxWidth: short ? 78 : 92,
                      color: theme.colors.canvas,
                      fontFamily: theme.fonts.semibold,
                      fontSize: 9,
                      letterSpacing: 0.8,
                      textAlign: 'center',
                    }}
                  >
                    {primaryLabel || primary.label}
                  </Text>
                </Pressable>
              ) : (
                <View
                  accessibilityLabel={currentCopy.description}
                  accessibilityRole="progressbar"
                  style={{
                    width: short ? 88 : compact ? 100 : 108,
                    height: short ? 88 : compact ? 100 : 108,
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 7,
                    borderRadius: 999,
                    backgroundColor: 'rgba(246,242,233,0.92)',
                  }}
                >
                  <Feather name="more-horizontal" size={27} color={theme.colors.canvas} />
                  <Text
                    style={{
                      color: theme.colors.canvas,
                      fontFamily: theme.fonts.semibold,
                      fontSize: 9,
                      letterSpacing: 1.1,
                    }}
                  >
                    {phase === 'arming' ? 'OPENING' : 'THINKING'}
                  </Text>
                </View>
              )}
            </View>
            ) : null}

            {hasSecondaryActions ? (
              <View
                accessibilityLabel="Voice interaction options"
                style={{
                  width: '100%',
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                }}
              >
                {phase === 'error' ? (
                  <SecondaryAction
                    accessibilityLabel={primary.accessibilityLabel}
                    icon="mic"
                    label={narrow ? 'Retry' : primaryLabel || primary.label}
                    onPress={onPrimaryPress}
                    theme={theme}
                  />
                ) : null}
                {onReturnToEpisode ? (
                  <SecondaryAction
                    accessibilityLabel={returnToEpisodeLabel}
                    emphasized
                    icon="play"
                    label={narrow || (compact && phase === 'error') ? 'Return' : returnToEpisodeLabel}
                    onPress={onReturnToEpisode}
                    theme={theme}
                  />
                ) : null}
              </View>
            ) : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}
