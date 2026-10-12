import { z } from 'zod';

const boundarySchema = z.object({
  endSeconds: z.number().finite().positive(),
  audioVersion: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.literal('audio-alignment'),
}).strict();

export type IntroResolution = { kind: 'skip'; endSeconds: number } | { kind: 'past-intro' | 'unverified' };

export function resolveIntro(position: number, duration: number, version: string, marker: unknown, audioKey: string | null): IntroResolution {
  const parsed = boundarySchema.safeParse(marker);
  if (!Number.isFinite(position) || !Number.isFinite(duration) || position < 0 || position > duration
    || audioKey !== `${version}.mp3` || !parsed.success || parsed.data.audioVersion !== version
    || parsed.data.endSeconds >= duration) return { kind: 'unverified' };
  return position < parsed.data.endSeconds ? { kind: 'skip', endSeconds: parsed.data.endSeconds } : { kind: 'past-intro' };
}
