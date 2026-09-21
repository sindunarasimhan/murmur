export type BoundedBodyResult =
  | { ok: true; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; reason: 'too-large' };

type BodySource = {
  body: ReadableStream<Uint8Array> | null;
  headers: Headers;
};

function declaredBodyLength(headers: Headers): number | undefined {
  const value = headers.get('content-length');
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : undefined;
}

/** Read a request or response body without ever buffering beyond the explicit ceiling. */
export async function readBoundedBody(
  source: BodySource,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<BoundedBodyResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new TypeError('maxBytes must be a non-negative safe integer.');
  }

  const declaredLength = declaredBodyLength(source.headers);
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    if (source.body && !source.body.locked) void source.body.cancel().catch(() => undefined);
    return { ok: false, reason: 'too-large' };
  }
  if (!source.body) return { ok: true, bytes: new Uint8Array(new ArrayBuffer(0)) };

  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const abortRead = () => void reader.cancel(signal?.reason).catch(() => undefined);

  if (signal?.aborted) abortRead();
  else signal?.addEventListener('abort', abortRead, { once: true });

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too-large' };
      }
      chunks.push(value);
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  } finally {
    signal?.removeEventListener('abort', abortRead);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
