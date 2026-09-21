import assert from 'node:assert/strict';
import test from 'node:test';

import { handlePodcastSearchPost } from '@/server/podcast-directory/handler';

const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>The Daily</title>
    <description>News from The New York Times.</description>
    <itunes:author>The New York Times</itunes:author>
    <itunes:image href="https://cdn.example.com/the-daily.jpg" />
    <item>
      <guid>debt-wave</guid>
      <title>A New Consumer Debt Wave</title>
      <description>Buy now, pay later expands.</description>
      <pubDate>Tue, 08 Sep 2026 09:00:00 GMT</pubDate>
      <enclosure url="https://audio.example.com/debt.mp3" type="audio/mpeg" length="100" />
    </item>
    <item>
      <guid>election-results</guid>
      <title>Election Results Explained</title>
      <description>What voters decided in the election results.</description>
      <pubDate>Mon, 07 Sep 2026 09:00:00 GMT</pubDate>
      <enclosure url="https://audio.example.com/election.mp3" type="audio/mpeg" length="100" />
    </item>
  </channel>
</rss>`;

function searchRequest(query: string, headers: Record<string, string> = {}): Request {
  return new Request('https://murmur.example/api/podcast-search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Murmur-Client': 'expo',
      ...headers,
    },
    body: JSON.stringify({ query }),
  });
}

test('discovers a show, loads its RSS feed, and selects the requested episode', async () => {
  const requestedUrls: string[] = [];
  const response = await handlePodcastSearchPost(
    searchRequest('Play the latest episode of The Daily about the election results'),
    {
      fetch: async (input) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.startsWith('https://itunes.apple.com/search?')) {
          return Response.json({
            results: [
              {
                collectionId: 99,
                collectionName: 'The Daily Zeitgeist',
                artistName: 'iHeartPodcasts',
                feedUrl: 'https://feeds.example.com/zeitgeist',
              },
              {
                collectionId: 42,
                collectionName: 'The Daily',
                artistName: 'The New York Times',
                feedUrl: 'https://feeds.example.com/daily',
                artworkUrl600: 'https://cdn.example.com/apple-daily.jpg',
              },
            ],
          });
        }
        assert.equal(url, 'https://feeds.example.com/daily');
        return new Response(feedXml, {
          headers: { 'Content-Type': 'application/rss+xml' },
        });
      },
    },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provider, 'apple-podcasts-rss');
  assert.equal(body.podcast.title, 'The Daily');
  assert.equal(body.episode.title, 'Election Results Explained');
  assert.equal(body.episode.audioAsset.url, 'https://audio.example.com/election.mp3');
  assert.match(requestedUrls[0] ?? '', /country=US/);
  assert.match(requestedUrls[0] ?? '', /term=The(?:\+|%20)Daily/);
});

test('rejects malformed and unidentified client requests before directory access', async () => {
  const invalidClient = await handlePodcastSearchPost(
    new Request('https://murmur.example/api/podcast-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'The Daily' }),
    }),
  );
  assert.equal(invalidClient.status, 403);

  const invalidQuery = await handlePodcastSearchPost(searchRequest(''));
  assert.equal(invalidQuery.status, 400);
});

test('returns a stable not-found response when the directory has no matches', async () => {
  const response = await handlePodcastSearchPost(searchRequest('A Missing Podcast'), {
    fetch: async () => Response.json({ results: [] }),
  });

  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, 'podcast_not_found');
  assert.equal(body.error.retryable, false);
});

test('does not substitute an adjacent or impersonator show for an explicit title request', async () => {
  const response = await handlePodcastSearchPost(searchRequest('joe rogan podcast'), {
    fetch: async () => Response.json({
      results: [
        {
          collectionId: 8675309,
          collectionName: 'The Joe Rogan AI Experience',
          artistName: 'Unofficial AI Network',
          feedUrl: 'https://feeds.example.com/not-joe-rogan',
        },
      ],
    }),
  });

  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, 'public_feed_unavailable');
  assert.equal(body.error.retryable, false);
});

test('retries one transient podcast-directory failure', async () => {
  let directoryAttempts = 0;
  const response = await handlePodcastSearchPost(searchRequest('The Daily'), {
    fetch: async (input) => {
      const url = String(input);
      if (url.startsWith('https://itunes.apple.com/search?')) {
        directoryAttempts += 1;
        if (directoryAttempts === 1) return new Response(null, { status: 503 });
        return Response.json({
          results: [{
            collectionId: 42,
            collectionName: 'The Daily',
            artistName: 'The New York Times',
            feedUrl: 'https://feeds.example.com/daily',
          }],
        });
      }
      return new Response(feedXml, { headers: { 'Content-Type': 'application/rss+xml' } });
    },
  });

  assert.equal(response.status, 200);
  assert.equal(directoryAttempts, 2);
});
