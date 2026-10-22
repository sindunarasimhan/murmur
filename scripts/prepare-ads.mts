import { backendConfig } from '../backend/config';
import { createDatabase } from '../backend/database';
import { createAdClassifier } from '../backend/ad-preprocessing';
import { prepareStoredAdPlan } from '../backend/ad-preparation-store';

const index = process.argv.indexOf('--episode');
const episode = index >= 0 ? process.argv[index + 1] : undefined;
if (!episode || episode.startsWith('--')) throw new Error('Supply --episode with one catalog episode id; --write opts into saving markers.');
const config = backendConfig();
const pool = createDatabase(config.databaseUrl);
try {
  const plan = await prepareStoredAdPlan(pool, episode, createAdClassifier(config), { persist: process.argv.includes('--write') });
  console.log(JSON.stringify({ episode, saved: process.argv.includes('--write'), plan }, null, 2));
} finally { await pool.end(); }
