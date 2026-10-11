import { AppRegistry } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import { Manrope_400Regular, Manrope_500Medium, Manrope_600SemiBold } from '@expo-google-fonts/manrope';
import { Newsreader_400Regular } from '@expo-google-fonts/newsreader';
import { InvocationStage } from '../src/features/lenny/invocation-stage';
import type { VoicePhase, VoiceState } from '../src/features/lenny/voice-controller';

function Preview() {
  const [loaded] = useFonts({ Manrope_400Regular, Manrope_500Medium, Manrope_600SemiBold, Newsreader_400Regular });
  if (!loaded) return null;
  const query = new URLSearchParams(window.location.search);
  const phase = (query.get('phase') ?? 'listening') as VoicePhase;
  const home = query.get('surface') === 'home';
  const state: VoiceState = {
    phase, microphone: query.get('mic') !== 'off', speechPlaying: phase === 'speaking',
    heard: query.get('heard') ?? 'Hey Murmur, pause the podcast',
    caption: phase === 'speaking' ? 'Pausing the podcast.' : '',
    error: query.get('error') === 'yes' ? 'Voice disconnected. Reopen Murmur to reconnect.' : undefined,
    episode: home ? undefined : { id: 'preview', title: 'Building a company and learning from customers', guest: 'Brian Halligan', showTitle: 'Lenny’s Podcast', description: '', audioVersion: 'preview', audioPath: null, status: 'ready', durationSeconds: 4800, transcriptReady: true },
  };
  return <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }, insets: { top: 0, bottom: 0, left: 0, right: 0 } }}>
    <InvocationStage state={state} playbackEntered={!home} seconds={270.375} captions={[{ startSeconds: 260, endSeconds: 280, text: 'Listen carefully to the people using your product.' }]} />
  </SafeAreaProvider>;
}

AppRegistry.registerComponent('DetailPreview', () => Preview);
AppRegistry.runApplication('DetailPreview', { rootTag: document.getElementById('root') });
