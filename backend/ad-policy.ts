import { z } from 'zod';
import { adAtPosition, validatedAdPlan, type AdPlan, type AdInterval } from '../shared/ad-plan';

export const verifiedAdSchema = z.object({
  id: z.string().min(1), startSeconds: z.number().finite().nonnegative(), endSeconds: z.number().finite().positive(),
  audioVersion: z.string().regex(/^[a-f0-9]{64}$/), source: z.literal('audio-review'),
}).strict();
export type VerifiedAd = z.infer<typeof verifiedAdSchema>;
export type AdResolution = { kind: 'skip'; ad: AdInterval } | { kind: 'outside-ad' | 'unverified' };

export function recordingAdPlan(audioVersion: string, duration: number, prepared: unknown, reviewed: unknown, audioKey: string | null): AdPlan {
  const plan = validatedAdPlan(prepared, audioVersion, duration);
  const reviewedValid = resolveAd(0, duration, audioVersion, reviewed, audioKey).kind !== 'unverified';
  const verified: AdInterval[] = reviewedValid ? z.array(verifiedAdSchema).parse(reviewed).map(({ id, startSeconds, endSeconds }) => ({ id, startSeconds, endSeconds, source: 'audio-review' })) : [];
  const intervals = [...(plan?.intervals ?? []).filter((candidate) => !verified.some((ad) => candidate.startSeconds < ad.endSeconds && candidate.endSeconds > ad.startSeconds)), ...verified].sort((a, b) => a.startSeconds - b.startSeconds);
  return { audioVersion, revision: plan?.revision ?? 1, status: plan?.status === 'ready' ? 'ready' : plan || verified.length ? 'partial' : 'unavailable',
    intervals, source: plan?.source ?? 'audio-review', timing: plan?.timing ?? 'reviewed' };
}

export function resolvePlannedAd(position: number, plan: AdPlan): AdResolution {
  if (plan.status === 'unavailable' || !plan.intervals.length) return { kind: 'unverified' };
  const ad = adAtPosition(plan, position);
  return ad ? { kind: 'skip', ad } : { kind: 'outside-ad' };
}

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
