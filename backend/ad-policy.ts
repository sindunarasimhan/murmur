import { z } from 'zod';

export const verifiedAdSchema = z.object({
  id: z.string().min(1), startSeconds: z.number().finite().nonnegative(), endSeconds: z.number().finite().positive(),
  audioVersion: z.string().regex(/^[a-f0-9]{64}$/), source: z.literal('audio-review'),
}).strict();
export type VerifiedAd = z.infer<typeof verifiedAdSchema>;
export type AdResolution = { kind: 'skip'; ad: VerifiedAd } | { kind: 'outside-ad' | 'unverified' };

/** Start-inclusive/end-exclusive. Overlaps, stale versions and uncertain markers never seek. */
export function resolveAd(position: number, duration: number, audioVersion: string, markers: unknown, audioKey: string | null): AdResolution {
  if (!Number.isFinite(position) || position < 0 || position > duration || audioKey !== `${audioVersion}.mp3`) return { kind: 'unverified' };
  const parsed = z.array(verifiedAdSchema).safeParse(markers);
  if (!parsed.success || !parsed.data.length) return { kind: 'unverified' };
  const ordered = [...parsed.data].sort((a, b) => a.startSeconds - b.startSeconds);
  if (ordered.some((ad, i) => ad.audioVersion !== audioVersion || ad.endSeconds <= ad.startSeconds || ad.endSeconds > duration || i > 0 && ordered[i - 1]!.endSeconds > ad.startSeconds)) return { kind: 'unverified' };
  const ad = ordered.find((ad) => ad.startSeconds <= position && position < ad.endSeconds);
  return ad ? { kind: 'skip', ad } : { kind: 'outside-ad' };
}
