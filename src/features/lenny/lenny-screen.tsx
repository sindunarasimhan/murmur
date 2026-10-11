import { useState } from 'react';
import { useLennyVoice } from './voice-provider';
import { InvocationStage } from './invocation-stage';

export function LennyScreen() {
  const { state, playing, seconds, captions, captionsError, talk } = useLennyVoice();
  const [playbackEntered, setPlaybackEntered] = useState(false);
  if (playing && state.episode && !playbackEntered) setPlaybackEntered(true);
  else if (!state.episode && playbackEntered) setPlaybackEntered(false);
  return <InvocationStage state={state} playbackEntered={playbackEntered} seconds={seconds} captions={captions} captionsError={captionsError} onTalk={talk} />;
}
