type EpisodePlayer = {
  readonly isLoaded: boolean;
  replace(source: { uri: string; name: string }): void;
  seekTo(seconds: number, toleranceBefore: number, toleranceAfter: number): Promise<void>;
};

function checkCancellation(signal: Pick<AbortSignal, 'aborted'>) {
  if (signal.aborted) {
    const error = new Error('Episode loading was cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

export async function loadEpisodeAudio(
  player: EpisodePlayer,
  source: { uri: string; name: string },
  position: number,
  signal: Pick<AbortSignal, 'aborted'>,
  hasError: () => boolean,
) {
  checkCancellation(signal);
  player.replace(source);
  const started = Date.now();
  while (!player.isLoaded) {
    checkCancellation(signal);
    if (hasError()) throw new Error('That episode could not be played. Try another guest.');
    if (Date.now() - started > 20_000) throw new Error('The episode took too long to load. Your place is saved.');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  checkCancellation(signal);
  await player.seekTo(position, 0, 0);
}
