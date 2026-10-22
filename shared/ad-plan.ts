import { z } from 'zod';

export const adIntervalSchema = z.object({
  id: z.string().min(1), startSeconds: z.number().finite().nonnegative(),
  endSeconds: z.number().finite().positive(),
  source: z.enum(['audio-review', 'transcript-classification']).optional(),
  probability: z.number().finite().min(0).max(1).optional(),
}).strict();
export const adPlanSchema = z.object({
  audioVersion: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().positive(),
  status: z.enum(['ready', 'partial', 'unavailable']),
  intervals: z.array(adIntervalSchema),
  source: z.enum(['audio-review', 'transcript-classification']).optional(),
  timing: z.enum(['reviewed', 'publisher-passages']).optional(),
}).strict();
export type AdPlan = z.infer<typeof adPlanSchema>;
export type AdInterval = z.infer<typeof adIntervalSchema>;

export function validatedAdPlan(value: unknown, audioVersion: string, duration: number): AdPlan | null {
  const result = adPlanSchema.safeParse(value);
  if (!result.success || result.data.audioVersion !== audioVersion || !Number.isFinite(duration) || duration <= 0) return null;
  const plan = result.data;
  if (plan.status === 'unavailable' && plan.intervals.length) return null;
  const ids = new Set<string>();
  for (const [index, interval] of plan.intervals.entries()) {
    if (ids.has(interval.id) || interval.endSeconds <= interval.startSeconds || interval.endSeconds > duration
      || index > 0 && plan.intervals[index - 1]!.endSeconds > interval.startSeconds) return null;
    ids.add(interval.id);
  }
  return plan;
}

export function adAtPosition(plan: AdPlan, position: number): AdInterval | undefined {
  if (!Number.isFinite(position) || position < 0 || plan.status === 'unavailable') return undefined;
  return plan.intervals.find((interval) => interval.startSeconds <= position && position < interval.endSeconds);
}

export function adDestination(plan: AdPlan, position: number): number | undefined {
  let destination = position;
  for (const interval of plan.intervals) {
    if (interval.startSeconds <= destination && destination < interval.endSeconds) destination = interval.endSeconds;
  }
  return destination === position ? undefined : destination;
}
