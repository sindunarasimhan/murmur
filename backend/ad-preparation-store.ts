import type { Pool } from 'pg';
import { preprocessAds, type AdClassifier } from './ad-preprocessing';
import { validatedAdPlan, type AdPlan } from '../shared/ad-plan';

export async function prepareStoredAdPlan(pool: Pool, episodeId: string, classify: AdClassifier, options: { persist?: boolean; signal?: AbortSignal } = {}): Promise<AdPlan> {
  const result = await pool.query('SELECT audio_version,duration_seconds,ad_plan FROM episodes WHERE id=$1 AND status=\'ready\'', [episodeId]);
  const episode = result.rows[0];
  if (!episode) throw new Error('Episode is not ready');
  const segments = await pool.query('SELECT id,start_seconds AS "startSeconds",end_seconds AS "endSeconds",text FROM transcript_segments WHERE episode_id=$1 AND audio_version=$2 ORDER BY start_seconds,id', [episodeId, episode.audio_version]);
  const prior = validatedAdPlan(episode.ad_plan, episode.audio_version, episode.duration_seconds);
  const plan = await preprocessAds({ audioVersion: episode.audio_version, durationSeconds: episode.duration_seconds, segments: segments.rows, revision: (prior?.revision ?? 0) + 1 }, classify, options.signal);
  if (options.persist) {
    const saved = await pool.query('UPDATE episodes SET ad_plan=$3 WHERE id=$1 AND audio_version=$2 AND ad_plan IS NOT DISTINCT FROM $4::jsonb', [episodeId, episode.audio_version, JSON.stringify(plan), episode.ad_plan == null ? null : JSON.stringify(episode.ad_plan)]);
    if (!saved.rowCount) throw new Error('Episode or ad plan changed during preparation; nothing saved');
  }
  return plan;
}
