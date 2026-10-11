export async function withRequestDeadline<T>(
  external: AbortSignal | undefined,
  milliseconds: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (external?.aborted) cancel();
  else external?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, milliseconds);
  try {
    if (controller.signal.aborted) {
      const error = new Error('Request cancelled.');
      error.name = 'AbortError';
      throw error;
    }
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', cancel);
  }
}
