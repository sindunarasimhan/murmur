import { backendConfig } from './config';
import { createDatabase, migrate } from './database';
import { ObjectStore } from './storage';
import { enqueuePreparedEpisode, prepareEpisode, PREPARE_QUEUE, startQueue } from './preparation';

async function main() {
  const config = backendConfig();
  const pool = createDatabase(config.databaseUrl);
  const objects = new ObjectStore(config.objectDirectory);
  await migrate(pool);
  const queue = await startQueue(config.databaseUrl);
  await enqueuePreparedEpisode(pool, queue);
  await queue.work<{ episodeId: string }>(PREPARE_QUEUE, { pollingIntervalSeconds: 1 }, async (jobs) => {
    for (const job of jobs) await prepareEpisode(pool, objects, job.data.episodeId);
  });
  // Account expiry also removes private sessions and turns through foreign keys.
  await pool.query('DELETE FROM identities WHERE expires_at<now()');
  await pool.query(`DELETE FROM usage_buckets WHERE day<CURRENT_DATE-31`);
  console.log('Murmur preparation worker ready');
  const stop = async () => { await queue.stop(); await pool.end(); };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
}
main().catch(() => { console.error('Murmur worker could not start. Check PostgreSQL and backend configuration.'); process.exitCode = 1; });
