import { useEffect } from 'react';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { usePathname, useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppTheme } from '@/design/use-app-theme';
import { useReducedMotion } from '@/design/use-reduced-motion';
import { VoiceAura } from '@/features/home/voice-aura';
import { BrandLockup } from '@/components/brand-lockup';
import { formatDuration } from '@/features/listening/format';
import { useLennyVoice } from './voice-provider';

export function LennyScreen() {
  const theme = useAppTheme();
  const reducedMotion = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const router = useRouter();
  const pathname = usePathname();
  const { state, activate, seconds, count, featured } = useLennyVoice();
  const { episode, phase, microphone } = state;
  useEffect(() => {
    if (episode && pathname !== '/listen') router.replace('/listen');
    else if (!episode && pathname === '/listen') router.replace('/');
  }, [episode, pathname, router]);
  const isListening = phase === 'listening' || phase === 'followup';
  const phaseLabel = phase === 'playing' ? 'NOW PLAYING' : isListening ? 'LISTENING TO YOU' : phase === 'thinking' ? 'FOLLOWING YOUR THOUGHT' : phase === 'speaking' ? 'MURMUR IS SPEAKING' : phase === 'paused' ? 'YOUR PLACE IS SAVED' : 'THE LENNY’S COLLECTION';
  return <View style={[styles.root, { backgroundColor: theme.colors.canvas }]}>
    <LinearGradient colors={[theme.colors.violetWash, 'transparent', theme.colors.coralWash]} style={StyleSheet.absoluteFill} />
    <ScrollView contentContainerStyle={[styles.page, { paddingTop: insets.top + 28, paddingBottom: insets.bottom + 26 }]}>
      <View style={styles.header}>
        <BrandLockup theme={theme} />
        <View style={styles.micStatus}>
          <View style={[styles.dot, { backgroundColor: microphone ? theme.colors.success : theme.colors.subtle }]} />
          <Text style={{ color: theme.colors.muted, fontFamily: theme.fonts.medium, fontSize: 11 }}>{microphone ? 'MICROPHONE ON' : 'MICROPHONE OFF'}</Text>
        </View>
      </View>
      <View style={styles.stage}>
        <Text style={[styles.eyebrow, { color: theme.colors.coral, fontFamily: theme.fonts.medium }]}>{phaseLabel}</Text>
        {episode ? <>
          <Image source={{ uri: episode.artworkUrl ?? undefined }} style={[styles.cover, { width: Math.min(width - 100, 260), height: Math.min(width - 100, 260) }]} contentFit="cover" accessibilityLabel="Lenny’s Podcast artwork" />
          <Text style={[styles.title, { color: theme.colors.ink, fontFamily: theme.fonts.display }]}>{episode.guest}</Text>
          <Text style={[styles.description, { color: theme.colors.muted, fontFamily: theme.fonts.body }]}>{episode.title}</Text>
          <Text style={{ color: theme.colors.subtle, fontFamily: theme.fonts.body, fontSize: 12 }}>{formatDuration(seconds)} / {formatDuration(episode.durationSeconds)}</Text>
          <View style={styles.wave} accessible={false}>{[9, 18, 28, 14, 35, 24, 12, 30, 18].map((height, index) => <View key={index} style={{ width: 3, height, borderRadius: 3, backgroundColor: phase === 'playing' ? theme.colors.coral : theme.colors.subtle, opacity: 0.45 + index % 3 * 0.2 }} />)}</View>
        </> : <>
          <Text style={[styles.title, { color: theme.colors.ink, fontFamily: theme.fonts.display, maxWidth: 440 }]}>{featured ? `Lenny meets\n${featured.guest}.` : 'Great minds.\nYour next conversation.'}</Text>
          <Text style={[styles.description, { color: theme.colors.muted, fontFamily: theme.fonts.body }]}>{featured ? 'Building a company. Becoming a better leader.\nA conversation you can interrupt.' : count ? `${count} conversations with Lenny.\nChoose one with your voice.` : 'Lenny’s Podcast, with room for your questions.'}</Text>
          <VoiceAura size={Math.min(width - 56, 310)} reducedMotion={reducedMotion} onPress={activate} accessibilityLabel="Hey Murmur"
            disabled={phase === 'connecting'} phase={phase === 'connecting' ? 'arming' : isListening ? 'listening' : phase === 'thinking' ? 'processing' : phase === 'error' ? 'error' : 'idle'}
            visualState={isListening ? 'listening' : phase === 'thinking' ? 'transcribing' : 'resting'}>
            <Text style={{ color: theme.colors.ink, fontFamily: theme.fonts.display, fontSize: 31 }}>Hey Murmur</Text>
            <Text style={{ color: theme.colors.muted, fontFamily: theme.fonts.body, fontSize: 12, marginTop: 8 }}>{phase === 'connecting' ? 'One moment…' : microphone ? 'I’m here with you' : 'Tap to begin'}</Text>
          </VoiceAura>
        </>}
        <View style={styles.conversation}>
          {state.heard ? <Text style={{ color: theme.colors.muted, fontFamily: theme.fonts.body, textAlign: 'center', lineHeight: 23 }}>“{state.heard}”</Text> : null}
          <Text accessibilityLiveRegion="polite" accessibilityRole={state.error ? 'alert' : 'text'} style={[styles.caption, { color: state.error ? theme.colors.coral : theme.colors.ink, fontFamily: theme.fonts.body }]}>{state.caption}</Text>
          {!microphone && !state.error ? <Text style={{ color: theme.colors.subtle, fontFamily: theme.fonts.body, fontSize: 13, textAlign: 'center' }}>{featured ? 'Say “Play Lenny” to begin.' : 'Try “Play Lenny” or “Find an episode about AI.”'}</Text> : null}
        </View>
      </View>
      <View style={styles.footer}>
        <Text style={{ color: theme.colors.subtle, fontFamily: theme.fonts.body, fontSize: 12, textAlign: 'center', lineHeight: 19 }}>{microphone ? 'Say “Hey Murmur” to interrupt. Say “stop listening” to switch the mic off.' : 'Listen. Ask. Go a little deeper.'}</Text>
        <Text style={{ color: theme.colors.subtle, fontFamily: theme.fonts.body, fontSize: 10, textAlign: 'center', lineHeight: 16 }}>After you begin, microphone audio is sent to OpenAI while Murmur is open. Murmur’s replies use an AI voice. Episode content © Lenny Rachitsky.</Text>
      </View>
    </ScrollView>
  </View>;
}
const styles = StyleSheet.create({
  root: { flex: 1 }, page: { flexGrow: 1, paddingHorizontal: 28, width: '100%', maxWidth: 900, alignSelf: 'center', gap: 24 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 16 },
  micStatus: { flexDirection: 'row', alignItems: 'center', gap: 7 }, dot: { width: 5, height: 5, borderRadius: 5 },
  stage: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 20, paddingVertical: 24 },
  eyebrow: { letterSpacing: 2.5, fontSize: 10, textAlign: 'center' },
  title: { fontSize: 42, lineHeight: 46, textAlign: 'center', maxWidth: 560 },
  description: { fontSize: 14, lineHeight: 23, textAlign: 'center', maxWidth: 450 },
  cover: { borderRadius: 22, marginVertical: 8 }, wave: { flexDirection: 'row', height: 36, alignItems: 'center', gap: 5, marginVertical: 4 },
  conversation: { minHeight: 72, maxWidth: 570, gap: 12, justifyContent: 'center' }, caption: { fontSize: 16, lineHeight: 26, textAlign: 'center' },
  footer: { gap: 10, maxWidth: 500, alignSelf: 'center' },
});
