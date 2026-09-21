import { readBoundedBody } from './read-bounded-body';

export type UpstreamErrorKind =
  | 'cancelled' | 'timeout' | 'unavailable' | 'rejected'
  | 'invalid' | 'empty' | 'authentication' | 'quota';

/** Safe operational details only: never retain provider bodies, credentials or prompts. */
export class UpstreamError extends Error {
  constructor(readonly kind: UpstreamErrorKind, readonly status?: number) {
    super(`Upstream request failed: ${kind}`);
    this.name = 'UpstreamError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function withDeadline<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw new UpstreamError('cancelled');
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new UpstreamError(timedOut ? 'timeout' : 'cancelled'));
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    return await Promise.race([work(controller.signal), aborted]);
  } catch (error) {
    if (signal?.aborted) throw new UpstreamError('cancelled');
    if (timedOut) throw new UpstreamError('timeout');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
  }
}

export async function readUpstreamBytes(response: Response, maxBytes: number, signal: AbortSignal) {
  const body = await readBoundedBody(response, maxBytes, signal);
  if (!body.ok) throw new UpstreamError('invalid');
  return body.bytes;
}

export async function readUpstreamJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const bytes = await readUpstreamBytes(response, maxBytes, signal);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new UpstreamError('invalid');
  }
}

async function checkStatus(response: Response, signal: AbortSignal) {
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) {
    throw new UpstreamError('authentication', response.status);
  }
  if (response.status === 429) {
    // A credit problem needs account action; retrying it wastes time and requests.
    let payload: unknown;
    try { payload = await readUpstreamJson(response, 64 * 1024, signal); } catch { /* optional error details */ }
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
    if (error?.code === 'insufficient_quota' || error?.type === 'insufficient_quota') {
      throw new UpstreamError('quota', response.status);
    }
  }
  throw new UpstreamError(
    response.status === 408 || response.status === 429 || response.status >= 500
      ? 'unavailable' : 'rejected',
    response.status,
  );
}

/** One deadline spans connection, headers and body consumption. No automatic paid retries. */
export async function requestUpstream<T>(
  url: string,
  init: RequestInit,
  options: { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs: number; allowRedirect?: boolean },
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return withDeadline(options.signal, options.timeoutMs, async (signal) => {
    let response: Response | undefined;
    try {
      response = await (options.fetch ?? fetch)(url, { ...init, signal });
      signal.throwIfAborted();
      if (!(options.allowRedirect && [301, 302, 303, 307, 308].includes(response.status))) {
        await checkStatus(response, signal);
      }
      const result = await consume(response, signal);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      if (signal.aborted) throw new UpstreamError('cancelled');
      throw new UpstreamError('unavailable');
    } finally {
      // Includes rejected HTTP responses and ignored redirect bodies.
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined);
    }
  });
}
