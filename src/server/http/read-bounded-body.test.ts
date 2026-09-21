import assert from 'node:assert/strict';
import test from 'node:test';

import { readBoundedBody } from './read-bounded-body';

function streamedBody(...chunks: string[]) {
  const encoder = new TextEncoder();
  return {
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  };
}

test('reads a streamed body through the exact byte limit', async () => {
  const result = await readBoundedBody(streamedBody('mur', 'mur'), 6);

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(new TextDecoder().decode(result.bytes), 'murmur');
});

test('stops buffering a streamed body once it crosses the byte limit', async () => {
  const result = await readBoundedBody(streamedBody('1234', '5678'), 7);

  assert.deepEqual(result, { ok: false, reason: 'too-large' });
});

test('rejects an oversized declared length without consuming the body', async () => {
  let opened = false;
  let cancelled = false;
  const result = await readBoundedBody(
    {
      headers: new Headers({ 'Content-Length': '9' }),
      body: {
        cancel() { cancelled = true; return Promise.resolve(); },
        getReader() {
          opened = true;
          throw new Error('The body should not be opened.');
        },
      } as unknown as ReadableStream<Uint8Array>,
    },
    8,
  );

  assert.deepEqual(result, { ok: false, reason: 'too-large' });
  assert.equal(opened, false);
  assert.equal(cancelled, true);
});

test('stops reading when its request signal is cancelled', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    readBoundedBody(streamedBody('murmur'), 64, controller.signal),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );
});
