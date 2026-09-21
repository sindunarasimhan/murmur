import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const children = new Set();
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
  }
  setTimeout(() => {
    for (const child of children) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
    }
    process.exit(code);
  }, 2500);
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
function launch(command, args, env = process.env, required = false) {
  const child = spawn(command, args, { env, stdio: 'inherit', detached: true });
  children.add(child);
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => {
      children.delete(child);
      if (required && !stopping) stop(code || 1);
      if (code === 0 || stopping) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
  // Long-running children report failure through the supervisor, never unhandled promises.
  if (required) void done.catch(() => stop(1));
  return done;
}
const port = process.env.MURMUR_BACKEND_PORT ?? '4545';
const backend = process.env.MURMUR_BACKEND_URL ?? `http://127.0.0.1:${port}`;
async function ready(path) {
  try { return await (await fetch(`${backend}${path}`, { signal: AbortSignal.timeout(1000) })).json(); }
  catch { return undefined; }
}
try {
  if ((await ready('/health'))?.status === 'ok') {
    console.log('Reusing the running Murmur backend.');
  } else {
    if (!process.env.DATABASE_URL) await launch('docker', ['compose', 'up', '-d', '--wait']);
    // LAN binding is needed for the iPhone's direct voice WebSocket in development.
    const env = { ...process.env, MURMUR_BACKEND_HOST: process.env.MURMUR_BACKEND_HOST ?? '0.0.0.0' };
    void launch(process.execPath, ['--import', 'tsx', 'backend/main.ts'], env, true);
  }
  const deadline = Date.now() + 30_000;
  while ((await ready('/health'))?.status !== 'ok') {
    if (Date.now() > deadline) throw new Error('Murmur could not start. Check the backend logs.');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const focus = process.env.MURMUR_CATALOG !== 'all';
  const expectedCount = focus ? 1 : 50;
  const prepared = (catalog) => Array.isArray(catalog) && catalog.length === expectedCount && (!focus || catalog[0].id === 'lenny-brian-halligan' && catalog[0].audioPath?.startsWith('/media/'));
  if (!prepared(await ready('/v2/catalog'))) {
    await launch(process.execPath, ['--import', 'tsx', 'scripts/import-lenny.mts']);
  }
  if (!prepared(await ready('/v2/catalog'))) throw new Error('Restart the existing backend to load the current Lenny collection.');
  console.log('Lenny is ready. Tap “Hey Murmur” on Home and say “Play Lenny.”');
  await launch('./script/build_and_run.sh', [process.argv[2] ?? 'start'], { ...process.env,
    MURMUR_SERVICES_STARTED: '1', MURMUR_BACKEND_URL: backend,
  });
  stop();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Murmur could not start.');
  stop(1);
}
