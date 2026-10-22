import { useEffect } from 'react';
import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';
import Animated, { cancelAnimation, Easing, interpolateColor, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import type { VoicePhase } from './voice-controller';

type Props = { size: number; phase: VoicePhase; reducedMotion: boolean; level?: number; tapCount?: number };

export function MurmurMascot({ size, phase, reducedMotion, level = 0, tapCount = 0 }: Props) {
  const blink = useSharedValue(1);
  const breath = useSharedValue(0);
  const voice = useSharedValue(0);
  const attention = useSharedValue(0);
  const jiggle = useSharedValue(0);
  const thought = useSharedValue(0);
  useEffect(() => {
    if (tapCount && !reducedMotion) jiggle.value = withSequence(withTiming(-3, { duration: 130, easing: Easing.out(Easing.cubic) }), withSpring(0, { damping: 9, stiffness: 130, mass: 0.7 }));
    else jiggle.value = 0;
    return () => cancelAnimation(jiggle);
  }, [jiggle, tapCount, reducedMotion]);
  const attentive = phase === 'listening' || phase === 'followup';
  useEffect(() => {
    thought.value = withTiming(phase === 'thinking' ? 1 : 0, { duration: reducedMotion ? 0 : 520, easing: Easing.inOut(Easing.cubic) });
    return () => cancelAnimation(thought);
  }, [phase, thought, reducedMotion]);
  useEffect(() => {
    attention.value = withTiming(attentive ? 1 : 0, { duration: reducedMotion ? 0 : 350 });
    return () => cancelAnimation(attention);
  }, [attention, attentive, reducedMotion]);
  useEffect(() => {
    if (!reducedMotion) {
      blink.value = withRepeat(withSequence(
        withDelay(3400, withTiming(0.08, { duration: 100 })), withTiming(1, { duration: 180 }),
        withDelay(5100, withTiming(0.08, { duration: 110 })), withTiming(1, { duration: 210 }),
      ), -1);
      breath.value = withRepeat(withSequence(
        withTiming(1, { duration: 2900, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 3300, easing: Easing.inOut(Easing.sin) }),
      ), -1);
    } else { blink.value = 1; breath.value = 0; }
    return () => { cancelAnimation(blink); cancelAnimation(breath); };
  }, [blink, breath, reducedMotion]);
  useEffect(() => {
    cancelAnimation(voice);
    const target = phase === 'speaking' && !reducedMotion ? Math.min(1, Math.max(0, level)) : 0;
    voice.value = withTiming(target, { duration: target > voice.value ? 110 : 210, easing: Easing.out(Easing.quad) });
    return () => cancelAnimation(voice);
  }, [phase, reducedMotion, voice, level]);
  const bodyStyle = useAnimatedStyle(() => ({ transform: [{ translateY: -breath.value * 5 - attention.value * 2 }, { rotate: `${(reducedMotion ? 0 : (breath.value - 0.5) * 1.1) + attention.value * (-2 + breath.value * 0.7) + jiggle.value}deg` }] }));
  const eyeStyle = useAnimatedStyle(() => ({ transform: [{ scaleY: blink.value }] }));
  const gazeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: thought.value * size * 0.009 }, { translateY: -thought.value * size * 0.011 }] }));
  const leftBrowStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${-24 - thought.value * 11}deg` }, { translateY: -attention.value * size * 0.003 }] }));
  const rightBrowStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${18 - attention.value * 15 - thought.value * 5}deg` }] }));
  const auraStyle = useAnimatedStyle(() => ({ opacity: attention.value * (0.18 + breath.value * 0.12), transform: [{ scale: 1 + breath.value * 0.04 }] }));
  const mouthStyle = useAnimatedStyle(() => ({ height: size * (0.013 + voice.value * 0.016), width: size * (0.105 - voice.value * 0.012), backgroundColor: interpolateColor(voice.value, [0, 0.3, 1], ['#49382D00', '#49382DCC', '#49382D']), transform: [{ rotate: '-12deg' }] }));
  return <View accessible accessibilityLabel={`Murmur, ${phase}`} style={{ width: size, height: size }}>
    <Animated.View pointerEvents="none" style={[styles.aura, auraStyle]} />
    <View style={[styles.shadow, { width: size * 0.48, left: size * 0.27, bottom: size * 0.055 }]} />
    <Animated.View style={[StyleSheet.absoluteFill, bodyStyle]}>
      <Image source={require('../../../assets/images/murmur-mascot-base.png')} style={{ width: size, height: size }} contentFit="contain" />
      <Animated.View style={[styles.brow, { left: '33%', top: '39%', width: '8%', height: '2.1%' }, leftBrowStyle]} />
      <Animated.View style={[styles.brow, { left: '65%', top: '35%', width: '7%', height: '2%' }, rightBrowStyle]} />
      {([{ left: '35%', top: '47%', width: '12%', height: '13%' }, { left: '65%', top: '42%', width: '10%', height: '12%' }] as const).map((position, index) => <Animated.View key={index} style={[styles.eye, position, eyeStyle]}>
        <Animated.View style={[styles.pupil, { left: '28%', top: '2%' }, gazeStyle]}><View style={styles.glint} /></Animated.View>
      </Animated.View>)}
      <Animated.View style={[styles.mouth, { left: '53%', top: '61%', width: '11%', backgroundColor: phase === 'speaking' ? '#49382D' : 'transparent', borderBottomWidth: size * 0.009 }, mouthStyle]} />
    </Animated.View>
  </View>;
}

const styles = StyleSheet.create({
  aura: { position: 'absolute', width: '82%', height: '82%', left: '9%', top: '9%', borderRadius: 200, backgroundColor: '#BAC8A4', filter: 'blur(16px)' },
  shadow: { position: 'absolute', height: 15, borderRadius: 100, backgroundColor: '#C9B89E', opacity: 0.3, filter: 'blur(9px)' },
  brow: { position: 'absolute', backgroundColor: '#65503D', borderRadius: 20 },
  eye: { position: 'absolute', overflow: 'hidden', borderRadius: 100, backgroundColor: '#FFF8EB', borderTopWidth: 2, borderColor: '#705B45', transform: [{ rotate: '-15deg' }] },
  pupil: { position: 'absolute', width: '67%', height: '88%', borderRadius: 100, backgroundColor: '#382E27' },
  glint: { position: 'absolute', width: '22%', height: '20%', top: '15%', right: '14%', borderRadius: 30, backgroundColor: '#FFFBF2' },
  mouth: { position: 'absolute', borderColor: '#604B36', borderBottomLeftRadius: 100, borderBottomRightRadius: 100, borderTopLeftRadius: 15, borderTopRightRadius: 15 },
});
