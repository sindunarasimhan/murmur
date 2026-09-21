import type { AudioMode } from 'expo-audio';

export const PLAYBACK_AUDIO_MODE: AudioMode = {
  allowsRecording: false,
  interruptionMode: 'doNotMix',
  playsInSilentMode: true,
  shouldPlayInBackground: false,
  shouldRouteThroughEarpiece: false,
  allowsBackgroundRecording: false,
};

export const RECORDING_AUDIO_MODE: AudioMode = {
  ...PLAYBACK_AUDIO_MODE,
  allowsRecording: true,
};
