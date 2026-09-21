import { resolve } from 'node:path';
import { getServerConfig } from '../src/server/config';
import { FOCUS_EPISODE_ID } from './focus-episode';

export function backendConfig() {
  const production = process.env.NODE_ENV === 'production';
  if (production && !process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (production && !process.env.MURMUR_OBJECT_DIR) throw new Error('MURMUR_OBJECT_DIR must point to a persistent mounted volume');
  return {
    providers: getServerConfig(),
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://murmur:murmur-local-development@127.0.0.1:55432/murmur',
    objectDirectory: resolve(process.env.MURMUR_OBJECT_DIR ?? '.murmur-data/objects'),
    port: Number(process.env.MURMUR_BACKEND_PORT ?? 4545),
    host: process.env.MURMUR_BACKEND_HOST ?? '127.0.0.1',
    secureCookies: production,
    focusEpisodeId: process.env.MURMUR_CATALOG === 'all' ? null : FOCUS_EPISODE_ID,
    dailyUserCalls: Number(process.env.MURMUR_DAILY_USER_CALLS ?? 60),
    dailyProjectCalls: Number(process.env.MURMUR_DAILY_PROJECT_CALLS ?? 300),
  };
}
export type BackendConfig = ReturnType<typeof backendConfig>;
