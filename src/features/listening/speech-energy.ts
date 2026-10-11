export function speechEnergy(channels: readonly { frames: readonly number[] }[]): number {
  let energy = 0;
  let count = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.frames.length; i += 8) {
      const sample = channel.frames[i]!;
      if (Number.isFinite(sample)) { energy += sample * sample; count++; }
    }
  }
  return count ? Math.min(1, Math.sqrt(energy / count) * 4) : 0;
}
