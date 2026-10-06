import type { VoicePhase, VoiceState } from './voice-controller';

type DetailPresentation = {
  voiceStatus: 'Connection interrupted' | 'Ready to retry' | 'Mic off' | 'Ready' | 'Connecting' | 'Listening' | 'Thinking' | 'Speaking';
  playbackStatus: 'Playing' | 'Paused' | undefined;
  heard: string;
  reply: string;
  error: boolean;
};

const phaseStatus: Record<VoicePhase, DetailPresentation['voiceStatus']> = {
  idle: 'Ready', connecting: 'Connecting', listening: 'Listening', thinking: 'Thinking',
  speaking: 'Thinking', followup: 'Listening', playing: 'Ready', paused: 'Ready', error: 'Connection interrupted',
};

export function detailPresentation(state: VoiceState): DetailPresentation {
  const error = Boolean(state.error) || state.phase === 'error';
  const speaking = state.phase === 'speaking' && state.speechPlaying;
  return {
    voiceStatus: error ? state.microphone ? 'Ready to retry' : 'Connection interrupted' : !state.microphone ? 'Mic off' : speaking ? 'Speaking' : state.followupOpen ? 'Listening' : phaseStatus[state.phase],
    playbackStatus: state.phase === 'playing' ? 'Playing' : state.phase === 'paused' ? 'Paused' : undefined,
    heard: state.heard,
    reply: error ? state.error || state.caption : speaking ? state.caption : '',
    error,
  };
}
