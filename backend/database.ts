import { readFile, readdir } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';

export function createDatabase(connectionString: string) {
  const pool = new Pool({ connectionString, max: 8, connectionTimeoutMillis: 5000, statement_timeout: 10_000 });
  // An idle connection can disappear when PostgreSQL restarts. Do not crash the service;
  // pg removes the failed client and opens a fresh connection for the next request.
  pool.on('error', () => console.warn('Murmur database connection interrupted; the next request will reconnect.'));
  return pool;
}
export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
export async function migrate(pool: Pool) {
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(8241701)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const directory = new URL('./migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name]);
      if (applied.rowCount) continue;
      await client.query(await readFile(new URL(name, directory), 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
    }
  });
}
