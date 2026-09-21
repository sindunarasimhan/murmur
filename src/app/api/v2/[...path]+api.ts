import { readBoundedBody } from '@/server/http/read-bounded-body';

// Same-origin HTTP bridge. The dedicated service owns authentication and application state.
async function proxy(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/api/v2/')) return new Response(null, { status: 404 });
  const headers = new Headers();
  for (const name of ['authorization', 'cookie', 'content-type', 'x-murmur-client', 'range']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const media = /^\/api\/v2\/media\/[a-f0-9]{64}\.(?:mp3|wav)$/.test(path) && ['GET', 'HEAD'].includes(request.method);
  const headerDeadline = new AbortController();
  const timer = media ? setTimeout(() => headerDeadline.abort(), 10_000) : undefined;
  try {
    // A long episode may stream for minutes. Bound the header wait, then let
    // the player's connection control cancellation instead of cutting it at 30s.
    const signal = AbortSignal.any([request.signal, media ? headerDeadline.signal : AbortSignal.timeout(30_000)]);
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await readBoundedBody(request, 16 * 1024, signal);
    if (body && !body.ok) return Response.json({ error: { code: 'too_large', message: 'That request is too large.' } }, { status: 413 });
    const upstream = await fetch(`${process.env.MURMUR_BACKEND_URL ?? 'http://127.0.0.1:4545'}${path.slice('/api'.length)}`, {
      method: request.method, headers,
      body: body?.ok ? body.bytes : undefined,
      signal, redirect: 'error',
    });
    clearTimeout(timer);
    const responseHeaders = new Headers({ 'Cache-Control': 'no-store' });
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'set-cookie', 'x-murmur-voice-disclosure']) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return Response.json({ error: { code: 'backend_unavailable', message: 'The listening service is unavailable. Please try again shortly.' } }, { status: 503 });
  } finally { clearTimeout(timer); }
}
export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const DELETE = proxy;
