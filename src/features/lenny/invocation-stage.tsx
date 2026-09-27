import { LinearGradient } from 'expo-linear-gradient';
import { StatusBar } from 'expo-status-bar';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { demoEpisode } from '@/data/demo-episode';
import { useReducedMotion } from '@/design/use-reduced-motion';
import { AmbientPodcastRail } from '@/features/home/ambient-podcast-rail';
import { MurmurMascot } from './murmur-mascot';
import type { VoiceState } from './voice-controller';

const backgroundEpisodes = [demoEpisode];

export function InvocationStage({ state }: { state: VoiceState }) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const reducedMotion = useReducedMotion();
  const listening = state.phase === 'listening' || state.phase === 'followup';
  const label = state.error ? 'LET’S RECONNECT' : listening ? 'I’M LISTENING' : state.phase === 'thinking' ? 'FINDING YOUR CONVERSATION' : state.phase === 'speaking' ? 'A LITTLE SOMETHING FOR YOU' : state.phase === 'connecting' ? 'GETTING READY' : state.microphone ? 'HERE WHEN YOU NEED ME' : 'A QUIET MOMENT';
  return <View style={styles.root}>
    <StatusBar style="dark" />
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[StyleSheet.absoluteFill, { opacity: 0.12 }]}>
      <AmbientPodcastRail episodes={backgroundEpisodes} reducedMotion={reducedMotion} speed={10} />
    </View>
    <LinearGradient pointerEvents="none" colors={['rgba(249,244,234,0.72)', 'rgba(249,244,234,0.2)', '#F1E8D9']} locations={[0, 0.4, 1]} style={StyleSheet.absoluteFill} />
    <ScrollView contentContainerStyle={[styles.page, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 20 }]}>
      <View style={styles.header}>
        <Text style={styles.brand}>murmur</Text>
        <View style={styles.mic}><View style={[styles.dot, { backgroundColor: state.microphone ? '#728064' : '#B8A990' }]} /><Text style={styles.micText}>{state.microphone ? 'Mic on' : 'Mic off'}</Text></View>
      </View>
      <View style={styles.stage}>
        <Text style={styles.eyebrow}>GOOD CONVERSATIONS, CLOSER.</Text>
        <Text style={styles.title}>Where shall we go?</Text>
        <View style={styles.mascot}><MurmurMascot size={Math.min(width - 24, height * 0.44, 390)} phase={state.speechPlaying ? 'speaking' : state.phase === 'speaking' ? 'thinking' : state.phase} reducedMotion={reducedMotion} /></View>
        <View style={styles.labelRow}><View style={[styles.dot, { backgroundColor: state.error ? '#A36648' : '#7B876C' }]} /><Text style={styles.label}>{label}</Text></View>
        <View style={styles.conversation}>
          {state.heard ? <Text style={styles.transcript}>“{state.heard}”</Text> : <Text style={styles.prompt}>{listening ? 'Tell me what you’d like to hear.' : state.microphone ? 'Just say “Hey Murmur.”' : 'Your next conversation starts here.'}</Text>}
          <Text accessibilityLiveRegion="polite" accessibilityRole={state.error ? 'alert' : 'text'} style={[styles.caption, state.error && styles.error]}>{state.caption}</Text>
        </View>
      </View>
      <View style={styles.footer}>
        <Text style={styles.hint}>{state.microphone ? '“Play Lenny’s podcast” · “Stop listening”' : state.error ? 'Check microphone access and connection, then reopen.' : state.phase === 'connecting' ? 'Allow microphone access to talk with Murmur.' : 'Listening resumes when you reopen the app.'}</Text>
        <Text style={styles.disclosure}>While the mic is on, audio is sent to OpenAI, including while waiting for “Hey Murmur.” Replies use an AI voice. Lenny’s collection is available in this preview.</Text>
      </View>
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
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 32, paddingBottom: 24 },
  eyebrow: { color: '#968773', fontSize: 9, letterSpacing: 2.4, fontFamily: 'Manrope_600SemiBold', textAlign: 'center' },
  title: { color: '#514A3D', fontFamily: 'Newsreader_400Regular', fontSize: 37, lineHeight: 44, textAlign: 'center', marginTop: 12 },
  mascot: { marginTop: 2, marginBottom: 4 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  label: { color: '#7F826B', fontFamily: 'Manrope_600SemiBold', fontSize: 9, letterSpacing: 1.8 },
  conversation: { minHeight: 98, alignItems: 'center', justifyContent: 'center', gap: 9, marginTop: 14, maxWidth: 430 },
  transcript: { color: '#504C3F', fontFamily: 'Newsreader_400Regular', fontSize: 26, lineHeight: 32, textAlign: 'center' },
  prompt: { color: '#655E50', fontFamily: 'Newsreader_400Regular', fontSize: 23, lineHeight: 29, textAlign: 'center' },
  caption: { color: '#877B68', fontFamily: 'Manrope_400Regular', fontSize: 12, lineHeight: 20, textAlign: 'center' },
  error: { color: '#995D40' },
  footer: { gap: 10, maxWidth: 410, alignSelf: 'center' },
  hint: { color: '#817761', fontFamily: 'Manrope_500Medium', fontSize: 11, lineHeight: 17, textAlign: 'center' },
  disclosure: { color: '#7D705F', fontFamily: 'Manrope_400Regular', fontSize: 10, lineHeight: 15, textAlign: 'center' },
});
