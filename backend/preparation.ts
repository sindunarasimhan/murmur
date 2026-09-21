import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PgBoss } from 'pg-boss';
import type { Pool } from 'pg';
import { z } from 'zod';
import { evidenceSchema } from '../shared/listening';
import { transaction } from './database';
import { ObjectStore } from './storage';

export const PREPARE_QUEUE = 'prepare-episode';
const manifestSchema = z.object({
  id: z.literal('small-places'), title: z.string(), showTitle: z.string(), description: z.string(),
  version: z.string().regex(/^[a-f0-9]{64}$/), durationSeconds: z.number().positive(), segments: z.array(evidenceSchema).min(1),
});
export async function preparedManifest() {
  return manifestSchema.parse(JSON.parse(await readFile(new URL('./fixtures/field-notes.json', import.meta.url), 'utf8')));
}
export async function startQueue(databaseUrl: string) {
  const boss = new PgBoss({ connectionString: databaseUrl, schema: 'murmur_jobs' });
  boss.on('error', () => console.error('Murmur job queue error; check database availability.'));
  await boss.start();
  await boss.createQueue(PREPARE_QUEUE, { retryLimit: 3, retryDelay: 5, expireInSeconds: 60 });
  return boss;
}
export async function enqueuePreparedEpisode(pool: Pool, boss: PgBoss) {
  const manifest = await preparedManifest();
  await pool.query(`INSERT INTO episodes(id,title,show_title,description,audio_version,duration_seconds,status)
    VALUES($1,$2,$3,$4,$5,$6,'queued') ON CONFLICT(id) DO NOTHING`,
  [manifest.id, manifest.title, manifest.showTitle, manifest.description, manifest.version, manifest.durationSeconds]);
  const current = await pool.query('SELECT status,audio_version FROM episodes WHERE id=$1', [manifest.id]);
  if (current.rows[0]?.status === 'ready' && current.rows[0].audio_version === manifest.version) return null;
  return boss.send(PREPARE_QUEUE, { episodeId: manifest.id }, { singletonKey: manifest.id, singletonSeconds: 30 });
}
export async function prepareEpisode(pool: Pool, objects: ObjectStore, episodeId: string) {
  const manifest = await preparedManifest();
  if (episodeId !== manifest.id) throw new Error('Only the prepared episode is supported in milestones 1 and 2');
  await pool.query(`UPDATE episodes SET status='processing' WHERE id=$1`, [episodeId]);
  try {
    const audio = await readFile(new URL('./fixtures/field-notes.wav', import.meta.url));
    if (createHash('sha256').update(audio).digest('hex') !== manifest.version) throw new Error('Prepared audio does not match its transcript');
    let priorEnd = 0;
    for (const segment of manifest.segments) {
      if (segment.startSeconds < priorEnd || segment.endSeconds > manifest.durationSeconds || segment.endSeconds <= segment.startSeconds) throw new Error('Invalid transcript alignment');
      priorEnd = segment.endSeconds;
    }
    const audioKey = await objects.put(audio, 'wav');
    const transcriptKey = await objects.put(Buffer.from(JSON.stringify(manifest)), 'json');
    await transaction(pool, async (client) => {
      await client.query('DELETE FROM transcript_segments WHERE episode_id=$1', [episodeId]);
      for (const segment of manifest.segments) await client.query(`INSERT INTO transcript_segments(episode_id,audio_version,id,start_seconds,end_seconds,text)
        VALUES($1,$2,$3,$4,$5,$6)`, [episodeId, manifest.version, segment.id, segment.startSeconds, segment.endSeconds, segment.text]);
      await client.query(`UPDATE episodes SET audio_version=$2,duration_seconds=$3,audio_key=$4,transcript_key=$5,status='ready',prepared_at=now() WHERE id=$1`,
        [episodeId, manifest.version, manifest.durationSeconds, audioKey, transcriptKey]);
    });
  } catch (error) {
    await pool.query(`UPDATE episodes SET status='failed' WHERE id=$1`, [episodeId]);
    throw error;
  }
}
