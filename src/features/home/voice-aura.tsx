import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { type PropsWithChildren, useEffect } from 'react';
import { Pressable, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

export type VoiceAuraPhase = 'idle' | 'arming' | 'listening' | 'processing' | 'error';
export type VoiceAuraVisualState = 'resting' | 'listening' | 'transcribing';

type VoiceAuraProps = PropsWithChildren<{
  accessibilityLabel: string;
  disabled?: boolean;
  metering?: number;
  onPress: () => void;
  phase: VoiceAuraPhase;
  reducedMotion: boolean;
  size: number;
  visualState: VoiceAuraVisualState;
}>;

const voiceAuraSource = require('@/assets/images/voice-aura.png');
const restingOrbSource = require('@/assets/images/voice-orb-resting.png');
const smokeWispSource = require('@/assets/images/voice-smoke-wisp-v2.png');
const smokeRibbonSource = require('@/assets/images/voice-smoke-ribbon-v2.png');
const smokeTextureLayers = [
  {
    asset: smokeRibbonSource,
    opacity: 0.42,
    phase: 0,
    scale: 1.36,
    skew: 1.18,
    travelX: 0.22,
    travelY: 0.09,
  },
  {
    asset: smokeWispSource,
    opacity: 0.36,
    phase: 0.33,
    scale: 1.1,
    skew: 0.82,
    travelX: 0.12,
    travelY: 0.2,
  },
  {
    asset: smokeRibbonSource,
    opacity: 0.31,
    phase: 0.67,
    scale: 1.2,
    skew: 1.34,
    travelX: 0.17,
    travelY: 0.15,
  },
] as const;

function clampMetering(metering?: number) {
  if (metering === undefined || !Number.isFinite(metering)) return undefined;
  return Math.min(1, Math.max(0, metering));
}

function SmokeTextureLayer({
  activation,
  fieldSize,
  index,
  inputLevel,
  layer,
  reducedMotion,
  speechActivation,
}: {
  activation: SharedValue<number>;
  fieldSize: number;
  index: number;
  inputLevel: SharedValue<number>;
  layer: typeof smokeTextureLayers[number];
  reducedMotion: boolean;
  speechActivation: SharedValue<number>;
}) {
  const driftX = useSharedValue(0);
  const driftY = useSharedValue(0);
  const curl = useSharedValue(0);
  const morph = useSharedValue(0);
  const diffuse = useSharedValue(0);

  useEffect(() => {
    cancelAnimation(driftX);
    cancelAnimation(driftY);
    cancelAnimation(curl);
    cancelAnimation(morph);
    cancelAnimation(diffuse);

    driftX.value = layer.phase;
    driftY.value = 1 - layer.phase;
    curl.value = layer.phase;
    morph.value = index % 2 ? 1 : 0;
    diffuse.value = 0;

    if (reducedMotion) return;

    driftX.value = withRepeat(
      withSequence(
        withTiming(0.86, { duration: 6_400 + index * 720, easing: Easing.inOut(Easing.sin), reduceMotion: ReduceMotion.Never }),
        withTiming(0.24, { duration: 7_150 + index * 610, easing: Easing.inOut(Easing.cubic), reduceMotion: ReduceMotion.Never }),
        withTiming(0.68, { duration: 5_900 + index * 830, easing: Easing.inOut(Easing.sin), reduceMotion: ReduceMotion.Never }),
        withTiming(layer.phase, { duration: 6_800 + index * 690, easing: Easing.inOut(Easing.quad), reduceMotion: ReduceMotion.Never }),
      ),
      -1,
      false,
      undefined,
      ReduceMotion.Never,
    );
    driftY.value = withRepeat(
      withSequence(
        withTiming(0.18, { duration: 7_300 + index * 640, easing: Easing.inOut(Easing.sin), reduceMotion: ReduceMotion.Never }),
        withTiming(0.78, { duration: 6_250 + index * 790, easing: Easing.inOut(Easing.cubic), reduceMotion: ReduceMotion.Never }),
        withTiming(0.42, { duration: 7_850 + index * 570, easing: Easing.inOut(Easing.sin), reduceMotion: ReduceMotion.Never }),
        withTiming(1 - layer.phase, { duration: 6_950 + index * 760, easing: Easing.inOut(Easing.quad), reduceMotion: ReduceMotion.Never }),
      ),
      -1,
      false,
      undefined,
      ReduceMotion.Never,
    );
    curl.value = withRepeat(
      withSequence(
        withTiming(0.88, { duration: 8_800 + index * 970, easing: Easing.inOut(Easing.sin), reduceMotion: ReduceMotion.Never }),
        withTiming(0.22, { duration: 9_650 + index * 860, easing: Easing.inOut(Easing.cubic), reduceMotion: ReduceMotion.Never }),
        withTiming(layer.phase, { duration: 8_150 + index * 1_020, easing: Easing.inOut(Easing.quad), reduceMotion: ReduceMotion.Never }),
      ),
      -1,
      false,
      undefined,
      ReduceMotion.Never,
    );
    morph.value = withRepeat(
      withSequence(
        withTiming(0.92, { duration: 4_900 + index * 430, easing: Easing.inOut(Easing.sin), reduceMotion: ReduceMotion.Never }),
        withTiming(0.18, { duration: 5_700 + index * 520, easing: Easing.inOut(Easing.cubic), reduceMotion: ReduceMotion.Never }),
        withTiming(0.64, { duration: 4_850 + index * 610, easing: Easing.inOut(Easing.sin), reduceMotion: ReduceMotion.Never }),
        withTiming(index % 2 ? 1 : 0, { duration: 5_250 + index * 480, easing: Easing.inOut(Easing.quad), reduceMotion: ReduceMotion.Never }),
      ),
      -1,
      false,
      undefined,
      ReduceMotion.Never,
    );
    diffuse.value = withRepeat(
      withSequence(
        withTiming(0.82, { duration: 4_450 + index * 520, easing: Easing.inOut(Easing.sin), reduceMotion: ReduceMotion.Never }),
        withTiming(0.18, { duration: 5_200 + index * 440, easing: Easing.inOut(Easing.sin), reduceMotion: ReduceMotion.Never }),
        withTiming(0.55, { duration: 4_900 + index * 590, easing: Easing.inOut(Easing.quad), reduceMotion: ReduceMotion.Never }),
        withTiming(0, { duration: 5_450 + index * 500, easing: Easing.inOut(Easing.sin), reduceMotion: ReduceMotion.Never }),
      ),
      -1,
      false,
      undefined,
      ReduceMotion.Never,
    );

    return () => {
      cancelAnimation(driftX);
      cancelAnimation(driftY);
      cancelAnimation(curl);
      cancelAnimation(morph);
      cancelAnimation(diffuse);
    };
  }, [curl, diffuse, driftX, driftY, index, layer.phase, morph, reducedMotion]);

  const animatedStyle = useAnimatedStyle(() => {
    const awake = activation.value;
    const speech = speechActivation.value;
    const voiceKick = inputLevel.value * speech;
    const travelScale = 1.08 + awake * 0.18 + voiceKick * 0.28;
    const x = (driftX.value - 0.5) * fieldSize * layer.travelX * travelScale;
    const y = (driftY.value - 0.5) * fieldSize * layer.travelY * travelScale;
    const curlValue = curl.value - 0.5;
    const morphValue = morph.value;
    const opacityBreath = diffuse.value;

    return {
      opacity: layer.opacity + opacityBreath * 0.07 + awake * 0.055 + speech * 0.04 + voiceKick * 0.07,
      transform: [
        { translateX: x },
        { translateY: y },
        { rotate: `${curlValue * (12 + index * 5)}deg` },
        { scaleX: layer.scale * layer.skew * (0.9 + morphValue * 0.22 + voiceKick * 0.12) },
        { scaleY: layer.scale * (1.08 - morphValue * 0.18 + opacityBreath * 0.08 + voiceKick * 0.1) },
      ],
    };
  });

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          top: -fieldSize * 0.3,
          left: -fieldSize * 0.38,
          width: fieldSize * 1.76,
          height: fieldSize * 1.6,
        },
        animatedStyle,
      ]}
    >
      <Image source={layer.asset} contentFit="contain" style={{ width: '100%', height: '100%' }} />
    </Animated.View>
  );
}

export function VoiceAura({
  accessibilityLabel,
  children,
  disabled = false,
  metering,
  onPress,
  phase,
  reducedMotion,
  size,
  visualState,
}: VoiceAuraProps) {
  const normalizedMetering = clampMetering(metering);
  const microphoneOpen = visualState === 'listening' || visualState === 'transcribing';
  const activelySpeaking = visualState === 'transcribing';
  const followsVoice = activelySpeaking && normalizedMetering !== undefined;
  const subdued = phase === 'error';
  const activation = useSharedValue(microphoneOpen ? 1 : 0);
  const speechActivation = useSharedValue(activelySpeaking ? 1 : 0);
  const restingLife = useSharedValue(0);
  const breathe = useSharedValue(0);
  const clockwise = useSharedValue(0);
  const signalFlow = useSharedValue(0);
  const inputLevel = useSharedValue(0);

  useEffect(() => {
    cancelAnimation(activation);
    const nextActivation = microphoneOpen ? 1 : 0;

    if (reducedMotion) {
      activation.value = nextActivation;
      return;
    }

    activation.value = withTiming(nextActivation, {
      duration: microphoneOpen ? 680 : 520,
      easing: Easing.bezier(0.2, 0.78, 0.2, 1),
      reduceMotion: ReduceMotion.Never,
    });

    return () => cancelAnimation(activation);
  }, [activation, microphoneOpen, reducedMotion]);

  useEffect(() => {
    cancelAnimation(speechActivation);
    const nextSpeechActivation = activelySpeaking ? 1 : 0;

    if (reducedMotion) {
      speechActivation.value = nextSpeechActivation;
      return;
    }

    speechActivation.value = withTiming(nextSpeechActivation, {
      duration: activelySpeaking ? 360 : 460,
      easing: Easing.inOut(Easing.quad),
      reduceMotion: ReduceMotion.Never,
    });

    return () => cancelAnimation(speechActivation);
  }, [activelySpeaking, reducedMotion, speechActivation]);

  useEffect(() => {
    cancelAnimation(restingLife);

    if (reducedMotion || visualState !== 'resting') {
      restingLife.value = 0;
      return;
    }

    restingLife.value = withRepeat(
      withTiming(1, {
        duration: 5_600,
        easing: Easing.inOut(Easing.sin),
        reduceMotion: ReduceMotion.Never,
      }),
      -1,
      true,
      undefined,
      ReduceMotion.Never,
    );

    return () => cancelAnimation(restingLife);
  }, [reducedMotion, restingLife, visualState]);

  useEffect(() => {
    cancelAnimation(breathe);

    if (reducedMotion) {
      breathe.value = 0;
      return;
    }

    if (!microphoneOpen) {
      breathe.value = withTiming(0, {
        duration: 420,
        easing: Easing.inOut(Easing.quad),
        reduceMotion: ReduceMotion.Never,
      });
      return () => cancelAnimation(breathe);
    }

    breathe.value = withRepeat(
      withTiming(1, {
        duration: activelySpeaking ? 2_250 : 4_800,
        easing: Easing.inOut(Easing.sin),
        reduceMotion: ReduceMotion.Never,
      }),
      -1,
      true,
      undefined,
      ReduceMotion.Never,
    );

    return () => cancelAnimation(breathe);
  }, [activelySpeaking, breathe, microphoneOpen, reducedMotion]);

  useEffect(() => {
    cancelAnimation(clockwise);

    if (reducedMotion) {
      clockwise.value = 0;
      return;
    }

    const nextClockwiseTurn = clockwise.value + 1;

    clockwise.value = withRepeat(
      withTiming(nextClockwiseTurn, {
        duration: microphoneOpen ? 52_000 : 18_000,
        easing: Easing.linear,
        reduceMotion: ReduceMotion.Never,
      }),
      -1,
      false,
      undefined,
      ReduceMotion.Never,
    );

    return () => cancelAnimation(clockwise);
  }, [clockwise, microphoneOpen, reducedMotion]);

  useEffect(() => {
    cancelAnimation(signalFlow);
    signalFlow.value = 0;

    if (reducedMotion) return;

    signalFlow.value = withRepeat(
      withTiming(1, {
        duration: activelySpeaking ? 1_250 : microphoneOpen ? 2_200 : 2_050,
        easing: Easing.linear,
        reduceMotion: ReduceMotion.Never,
      }),
      -1,
      false,
      undefined,
      ReduceMotion.Never,
    );

    return () => cancelAnimation(signalFlow);
  }, [activelySpeaking, microphoneOpen, reducedMotion, signalFlow]);

  useEffect(() => {
    cancelAnimation(inputLevel);
    const nextLevel = followsVoice ? normalizedMetering : 0;
    if (reducedMotion) {
      inputLevel.value = nextLevel;
      return;
    }

    inputLevel.value = withTiming(nextLevel, {
      duration: followsVoice ? 95 : 360,
      easing: followsVoice ? Easing.out(Easing.quad) : Easing.inOut(Easing.quad),
      reduceMotion: ReduceMotion.Never,
    });
  }, [followsVoice, inputLevel, microphoneOpen, normalizedMetering, reducedMotion]);

  const dormantSphereStyle = useAnimatedStyle(() => {
    const awake = activation.value;
    const life = restingLife.value;

    return {
      opacity: subdued ? 0.3 : 0.58 - awake * 0.5,
      transform: [
        { translateX: (life - 0.5) * 1.6 },
        { translateY: (0.5 - life) * 1.4 },
        { scale: 0.962 + life * 0.012 + awake * 0.024 },
      ],
    };
  });

  const dormantSheenStyle = useAnimatedStyle(() => {
    const awake = activation.value;
    const life = restingLife.value;

    return {
      opacity: (1 - awake) * (0.035 + life * 0.028),
      transform: [
        { translateX: (life - 0.5) * 3.4 },
        { translateY: (0.5 - life) * 2.8 },
        { rotate: `${-2 + life * 4}deg` },
        { scale: 0.952 + life * 0.018 },
      ],
    };
  });

  const haloStyle = useAnimatedStyle(() => {
    const voiceSignal = activelySpeaking
      ? breathe.value * 0.18 + inputLevel.value * 0.82
      : breathe.value * 0.26;
    const awake = activation.value;
    const speech = speechActivation.value;

    return {
      opacity: subdued ? 0.018 : 0.14 + awake * (0.08 + speech * 0.08 + voiceSignal * 0.18),
      transform: [
        {
          scale: 0.92 + awake * 0.08 + voiceSignal * (0.035 + speech * 0.08),
        },
      ],
    };
  });

  const frontLayerStyle = useAnimatedStyle(() => {
    const signal = activelySpeaking
      ? breathe.value * 0.2 + inputLevel.value * 0.8
      : breathe.value * 0.25;
    const awake = activation.value;
    const speech = speechActivation.value;
    const rotation = reducedMotion ? 0 : -0.6 + clockwise.value * (microphoneOpen ? 1.2 : 16);

    return {
      opacity: subdued
        ? 0.012 + awake * 0.04
        : 0.06
          + (1 - awake) * 0.055
          + awake * 0.12
          + speech * 0.055
          + signal * (0.035 + speech * 0.055),
      transform: [
        { rotate: `${rotation * 0.4}deg` },
        {
          scale: 0.94 + (1 - awake) * signal * 0.015 + awake * 0.04 + signal * (0.014 + speech * 0.034),
        },
      ],
    };
  });

  const glassShellStyle = useAnimatedStyle(() => {
    const awake = activation.value;
    const voiceSignal = activelySpeaking
      ? inputLevel.value * 0.72 + breathe.value * 0.28
      : breathe.value * 0.18 + restingLife.value * 0.1;

    return {
      opacity: subdued ? 0.62 : 0.88 + awake * 0.04 + voiceSignal * 0.035,
      transform: [
        { translateX: (restingLife.value - 0.5) * 1.8 },
        { translateY: (0.5 - restingLife.value) * 1.4 },
        { scale: 0.968 + awake * 0.018 + voiceSignal * 0.014 },
      ],
    };
  });

  const glassHighlightStyle = useAnimatedStyle(() => {
    const awake = activation.value;
    const voiceSignal = activelySpeaking
      ? inputLevel.value * 0.74 + breathe.value * 0.26
      : breathe.value * 0.16 + restingLife.value * 0.12;

    return {
      opacity: subdued ? 0.14 : 0.32 + awake * 0.1 + voiceSignal * 0.16,
      transform: [
        { translateX: -size * 0.06 + voiceSignal * size * 0.045 },
        { translateY: -size * 0.08 - voiceSignal * size * 0.03 },
        { rotate: '-16deg' },
        { scaleX: 1 + voiceSignal * 0.08 },
        { scaleY: 1 - voiceSignal * 0.04 },
      ],
    };
  });

  const innerSignalGlowStyle = useAnimatedStyle(() => {
    const awake = activation.value;
    const resting = 1 - awake;
    const speech = speechActivation.value;
    const voiceSignal = activelySpeaking
      ? inputLevel.value * 0.82 + breathe.value * 0.18
      : breathe.value * 0.32;
    const idlePulse = (Math.sin(signalFlow.value * Math.PI * 2) + 1) / 2;

    return {
      opacity: subdued
        ? 0.02
        : 0.08 + resting * (0.09 + idlePulse * 0.11) + awake * 0.14 + speech * 0.1 + voiceSignal * 0.14,
      transform: [
        { scale: 0.72 + resting * idlePulse * 0.12 + awake * 0.08 + voiceSignal * 0.16 },
      ],
    };
  });

  const smokeReadabilityStyle = useAnimatedStyle(() => {
    const awake = activation.value;
    const speech = speechActivation.value;
    const voiceSignal = activelySpeaking
      ? inputLevel.value * 0.7 + breathe.value * 0.3
      : breathe.value * 0.22;

    return {
      opacity: subdued ? 0.42 : 0.57 + awake * 0.045 + speech * 0.035 + voiceSignal * 0.025,
      transform: [
        { scale: 0.7 + awake * 0.025 + voiceSignal * 0.02 },
      ],
    };
  });

  const imageStyle = { width: '100%' as const, height: '100%' as const };
  const smokeFieldSize = size * 0.86;

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{
        busy: phase === 'arming' || phase === 'processing',
        disabled,
      }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.96 : 1,
      })}
    >
      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          {
            position: 'absolute',
            inset: size * 0.055,
            borderRadius: 999,
            backgroundColor: 'rgba(142,39,86,0.1)',
            boxShadow: '0 0 68px rgba(236,70,151,0.28), 0 0 118px rgba(233,108,70,0.13)',
            pointerEvents: 'none',
          },
          haloStyle,
        ]}
      />

      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          {
            position: 'absolute',
            inset: size * 0.055,
            borderRadius: 999,
            overflow: 'hidden',
            borderWidth: 1,
            borderColor: 'rgba(255,202,222,0.2)',
            backgroundColor: 'rgba(24,5,18,0.56)',
            boxShadow: 'inset 0 0 36px rgba(255,226,235,0.08), inset 0 -28px 76px rgba(4,0,4,0.64), 0 0 42px rgba(214,58,132,0.15)',
            pointerEvents: 'none',
          },
          glassShellStyle,
        ]}
      >
        <LinearGradient
          colors={[
            'rgba(255,220,232,0.13)',
            'rgba(214,74,139,0.045)',
            'rgba(124,31,73,0.09)',
            'rgba(10,1,8,0.5)',
          ]}
          end={{ x: 0.82, y: 1 }}
          locations={[0, 0.32, 0.66, 1]}
          start={{ x: 0.18, y: 0.02 }}
          style={{ position: 'absolute', inset: 0 }}
        />
      </Animated.View>

      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[{ position: 'absolute', inset: 0, pointerEvents: 'none' }, frontLayerStyle]}
      >
        <Image source={voiceAuraSource} contentFit="contain" style={imageStyle} />
      </Animated.View>

      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[{ position: 'absolute', inset: 0, pointerEvents: 'none' }, dormantSphereStyle]}
      >
        <Image source={restingOrbSource} contentFit="contain" style={imageStyle} />
      </Animated.View>

      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[{ position: 'absolute', inset: 0, pointerEvents: 'none' }, dormantSheenStyle]}
      >
        <Image source={restingOrbSource} contentFit="contain" style={imageStyle} />
      </Animated.View>

      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          {
            position: 'absolute',
            inset: size * 0.075,
            borderRadius: 999,
            borderWidth: 1,
            borderColor: 'rgba(255,196,219,0.12)',
            backgroundColor: 'rgba(124,31,73,0.04)',
            boxShadow: 'inset 0 0 38px rgba(255,225,235,0.06), 0 0 44px rgba(222,65,139,0.13), 0 0 88px rgba(233,108,70,0.08)',
            pointerEvents: 'none',
          },
          innerSignalGlowStyle,
        ]}
      />

      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          {
            position: 'absolute',
            top: size * 0.16,
            left: size * 0.23,
            width: size * 0.26,
            height: size * 0.09,
            backgroundColor: 'rgba(255,244,247,0.1)',
            boxShadow: '0 0 28px rgba(255,244,247,0.2)',
            borderRadius: 999,
            pointerEvents: 'none',
          },
          glassHighlightStyle,
        ]}
      />

      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          position: 'absolute',
          top: (size - smokeFieldSize) / 2,
          left: (size - smokeFieldSize) / 2,
          width: smokeFieldSize,
          height: smokeFieldSize,
          overflow: 'hidden',
          borderRadius: 999,
          opacity: subdued ? 0.24 : 1,
          pointerEvents: 'none',
        }}
      >
        {smokeTextureLayers.map((layer, index) => (
          <SmokeTextureLayer
            activation={activation}
            fieldSize={smokeFieldSize}
            index={index}
            inputLevel={inputLevel}
            key={`${layer.phase}-${index}`}
            layer={layer}
            reducedMotion={reducedMotion}
            speechActivation={speechActivation}
          />
        ))}
        <View
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 999,
            backgroundColor: 'rgba(10,1,8,0.08)',
            pointerEvents: 'none',
          }}
        />
      </View>

      <Animated.View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[
          {
            position: 'absolute',
            inset: size * 0.19,
            borderRadius: 999,
            backgroundColor: 'rgba(12,2,9,0.54)',
            boxShadow: '0 0 42px rgba(12,2,9,0.82), 0 0 92px rgba(18,4,13,0.54)',
            pointerEvents: 'none',
          },
          smokeReadabilityStyle,
        ]}
      />

      <View
        style={{
          position: 'absolute',
          inset: size * 0.16,
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
        {children}
      </View>
    </Pressable>
  );
}
