import { backendConfig } from './config';
import { createDatabase, migrate } from './database';
import { ObjectStore } from './storage';
import { createApp } from './app';
import { enqueuePreparedEpisode, startQueue } from './preparation';

async function main() {
  const config = backendConfig();
  const pool = createDatabase(config.databaseUrl);
  await migrate(pool);
  const queue = await startQueue(config.databaseUrl);
  await enqueuePreparedEpisode(pool, queue);
  await queue.stop();
  const { app } = await createApp({ config, pool, objects: new ObjectStore(config.objectDirectory) });
  await app.listen({ port: config.port, host: config.host });
  console.log(`Murmur backend listening on port ${config.port}`);
  const stop = async () => { await app.close(); await pool.end(); };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
}
main().catch(() => { console.error('Murmur backend could not start. Check PostgreSQL and backend configuration.'); process.exitCode = 1; });
