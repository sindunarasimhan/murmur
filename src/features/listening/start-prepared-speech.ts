type PreparedPlayer = { readonly isLoaded: boolean; play(): void };

export async function startPreparedSpeech(
  player: PreparedPlayer,
  active: () => boolean,
  wait: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 25)),
) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (!active()) {
      const error = new Error('Speech was cancelled.');
      error.name = 'AbortError';
      throw error;
    }
    if (player.isLoaded) { player.play(); return; }
    if (Date.now() >= deadline) throw new Error('Murmur’s voice took too long to load.');
    await wait();
  }
}
