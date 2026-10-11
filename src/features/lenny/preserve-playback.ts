type Player = { readonly playing: boolean; play(): void };

export async function preservePlayback(player: Player, transition: () => Promise<void>, current: () => boolean) {
  const wasPlaying = player.playing;
  try { await transition(); }
  finally { if (current() && wasPlaying && !player.playing) player.play(); }
}
