import { useEffect } from 'react';
import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import type { VoicePhase } from './voice-controller';

type Props = { size: number; phase: VoicePhase; reducedMotion: boolean };

export function MurmurMascot({ size, phase, reducedMotion }: Props) {
  const blink = useSharedValue(1);
  const breath = useSharedValue(0);
  const voice = useSharedValue(0);
  const attentive = phase === 'listening' || phase === 'followup';
  useEffect(() => {
    if (!reducedMotion) {
      blink.value = withRepeat(withSequence(withDelay(3700, withTiming(0.08, { duration: 110 })), withTiming(1, { duration: 170 })), -1);
      breath.value = withRepeat(withTiming(1, { duration: 2600 }), -1, true);
    } else { blink.value = 1; breath.value = 0; }
    return () => { cancelAnimation(blink); cancelAnimation(breath); };
  }, [blink, breath, reducedMotion]);
  useEffect(() => {
    cancelAnimation(voice);
    voice.value = phase === 'speaking' && !reducedMotion ? withRepeat(withTiming(1, { duration: 190 }), -1, true) : 0;
    return () => cancelAnimation(voice);
  }, [phase, reducedMotion, voice]);
  const bodyStyle = useAnimatedStyle(() => ({ transform: [{ translateY: -breath.value * 5 }, { rotate: `${attentive ? -2 : 0}deg` }] }));
  const eyeStyle = useAnimatedStyle(() => ({ transform: [{ scaleY: blink.value }] }));
  const mouthStyle = useAnimatedStyle(() => ({ height: size * (phase === 'speaking' ? 0.026 + voice.value * 0.03 : 0.025), transform: [{ rotate: '-12deg' }] }));
  return <View accessible accessibilityLabel={`Murmur, ${phase}`} style={{ width: size, height: size }}>
    <View style={[styles.shadow, { width: size * 0.48, left: size * 0.27, bottom: size * 0.055 }]} />
    <Animated.View style={[StyleSheet.absoluteFill, bodyStyle]}>
      <Image source={require('../../../assets/images/murmur-mascot-base.png')} style={{ width: size, height: size }} contentFit="contain" />
      <View style={[styles.brow, { left: '33%', top: '39%', width: '8%', height: '2.1%', transform: [{ rotate: phase === 'thinking' ? '-35deg' : '-24deg' }] }]} />
      <View style={[styles.brow, { left: '65%', top: '35%', width: '7%', height: '2%', transform: [{ rotate: attentive ? '3deg' : '18deg' }] }]} />
      {([{ left: '35%', top: '47%', width: '12%', height: '13%' }, { left: '65%', top: '42%', width: '10%', height: '12%' }] as const).map((position, index) => <Animated.View key={index} style={[styles.eye, position, eyeStyle]}>
        <View style={[styles.pupil, { left: phase === 'thinking' ? '37%' : '28%', top: phase === 'thinking' ? '-8%' : '2%' }]}><View style={styles.glint} /></View>
      </Animated.View>)}
      <Animated.View style={[styles.mouth, { left: '53%', top: '61%', width: '11%', backgroundColor: phase === 'speaking' ? '#49382D' : 'transparent', borderBottomWidth: size * 0.009 }, mouthStyle]} />
    </Animated.View>
  </View>;
}

const styles = StyleSheet.create({
  shadow: { position: 'absolute', height: 15, borderRadius: 100, backgroundColor: '#C9B89E', opacity: 0.3, filter: 'blur(9px)' },
  brow: { position: 'absolute', backgroundColor: '#65503D', borderRadius: 20 },
  eye: { position: 'absolute', overflow: 'hidden', borderRadius: 100, backgroundColor: '#FFF8EB', borderTopWidth: 2, borderColor: '#705B45', transform: [{ rotate: '-15deg' }] },
  pupil: { position: 'absolute', width: '67%', height: '88%', borderRadius: 100, backgroundColor: '#382E27' },
  glint: { position: 'absolute', width: '22%', height: '20%', top: '15%', right: '14%', borderRadius: 30, backgroundColor: '#FFFBF2' },
  mouth: { position: 'absolute', borderColor: '#604B36', borderBottomLeftRadius: 100, borderBottomRightRadius: 100, borderTopLeftRadius: 15, borderTopRightRadius: 15 },
});
