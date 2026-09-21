import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverEpisode } from './discovery-service';
import { handlePodcastSearchPost } from './handler';
import { parsePublicHttpsUrl } from './public-url';
import { UpstreamError } from '../http/upstream';

const directory = { results: [{ collectionId: 1, collectionName: 'The Daily', feedUrl: 'https://feeds.example.com/daily' }] };
function request(signal?: AbortSignal) {
  return new Request('http://localhost/api/podcast-search', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Murmur-Client': 'expo' },
    body: JSON.stringify({ query: 'The Daily' }), signal,
  });
}

test('discovery has a total deadline, including a feed body stalled after headers', async () => {
  let cancelled = false;
  await assert.rejects(discoverEpisode('The Daily', {
    signal: new AbortController().signal, timeoutMs: 20,
    fetch: async url => String(url).includes('itunes') ? Response.json(directory)
      : new Response(new ReadableStream({ cancel() { cancelled = true; } })),
  }), (error: unknown) => error instanceof UpstreamError && error.kind === 'timeout');
  assert.equal(cancelled, true);
});

test('cancelled directory access is not retried or disguised as an unavailable feed', async () => {
  const controller = new AbortController();
  let calls = 0;
  const response = await handlePodcastSearchPost(request(controller.signal), { fetch: async () => {
    calls += 1;
    controller.abort();
    throw new DOMException('Cancelled', 'AbortError');
  } });
  assert.equal(response.status, 499);
  assert.equal(calls, 1);
});

test('directory permanent errors and rate limits are never immediately retried', async () => {
  for (const status of [400, 403, 429]) {
    let calls = 0;
    const response = await handlePodcastSearchPost(request(), { fetch: async () => {
      calls += 1;
      return new Response(null, { status });
    } });
    assert.equal(response.status, 503);
    assert.equal(calls, 1);
  }
});

test('a malformed successful directory response is a provider failure, not a false no-match', async () => {
  const response = await handlePodcastSearchPost(request(), { fetch: async () => Response.json({ error: 'bad response' }) });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'directory_unavailable');
});

test('feed redirects cannot reach IP literals, local hostnames, credentials, or alternate ports', async () => {
  for (const location of [
    'https://127.0.0.1/feed', 'https://2130706433/feed', 'https://[::ffff:127.0.0.1]/feed',
    'https://[fd00::1]/feed', 'https://localhost./feed', 'https://service.internal/feed',
    'https://user:password@feeds.example.com/feed', 'https://feeds.example.com:8443/feed', 'http://feeds.example.com/feed',
  ]) {
    assert.equal(parsePublicHttpsUrl(location), undefined);
    let calls = 0;
    const response = await handlePodcastSearchPost(request(), { fetch: async url => {
      calls += 1;
      return String(url).includes('itunes') ? Response.json(directory) : new Response(null, { status: 302, headers: { location } });
    } });
    assert.equal(response.status, 502);
    assert.equal(calls, 2);
  }
});
