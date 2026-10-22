import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { backendConfig } from './config';
import { createDatabase, migrate } from './database';
import { importPublicTranscriptFeed } from './public-transcript-ingest';

const version = 'a'.repeat(64);
const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Public Transcript Show</title>
    <description>Episodes with publisher transcripts.</description>
    <item>
      <guid>episode-one</guid>
      <title>Learning from transcripts</title>
      <description>Transcript-backed catalog episode.</description>
      <pubDate>Fri, 09 Oct 2026 10:00:00 GMT</pubDate>
      <itunes:duration>00:02:00</itunes:duration>
      <enclosure url="https://cdn.example.com/audio.mp3" type="audio/mpeg" length="1000" />
      <podcast:transcript url="https://cdn.example.com/transcript.vtt" type="text/vtt" language="en" />
    </item>
    <item>
      <guid>episode-two</guid>
      <title>No transcript yet</title>
      <description>No public timed transcript.</description>
      <itunes:duration>00:01:00</itunes:duration>
      <enclosure url="https://cdn.example.com/audio-two.mp3" type="audio/mpeg" length="1000" />
    </item>
  </channel>
</rss>`;

const transcriptVtt = `WEBVTT

00:00:00.000 --> 00:00:30.000
Welcome to the show.

00:00:30.000 --> 00:00:45.000
This episode is sponsored by Example Cloud.

00:00:45.000 --> 00:02:00.000
Now back to the interview.
`;

function fakeFetch(input: string | URL | Request): Promise<Response> {
  const url = String(input);
  if (url === 'https://example.com/feed.xml') {
    return Promise.resolve(new Response(feedXml, { headers: { 'Content-Type': 'application/rss+xml' } }));
  }
  if (url === 'https://cdn.example.com/transcript.vtt') {
    return Promise.resolve(new Response(transcriptVtt, { headers: { 'Content-Type': 'text/vtt' } }));
  }
  return Promise.resolve(new Response('missing', { status: 404 }));
}

test('public transcript importer stores only episodes with timed public transcripts and runs ad preprocessing', { timeout: 30_000 }, async () => {
  const config = backendConfig();
  const admin = createDatabase(config.databaseUrl);
  const database = `murmur_public_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${database}`);
  const url = new URL(config.databaseUrl); url.pathname = `/${database}`;
  const pool = createDatabase(url.toString());
  try {
    await migrate(pool);
    const result = await importPublicTranscriptFeed({
      pool,
      config,
      label: 'Public Transcript Show',
      feedUrl: 'https://example.com/feed.xml',
      limit: 5,
      fetch: fakeFetch as typeof fetch,
      classifyAds: async (passages) => passages.map((passage) => ({
        id: passage.id,
        classification: passage.text.includes('sponsored') ? 'advertisement' : 'content',
        probability: 0.99,
      })),
    });
    assert.equal(result.totalEpisodes, 2);
    assert.equal(result.timedTranscriptEpisodes, 1);
    assert.equal(result.importedEpisodes, 1);
    const [episodeId] = result.episodeIds;
    assert(episodeId?.startsWith('public-'));
    const episode = await pool.query('SELECT show_title,collection,status,audio_url,ad_plan FROM episodes WHERE id=$1', [episodeId]);
    assert.equal(episode.rows[0]?.show_title, 'Public Transcript Show');
    assert.equal(episode.rows[0]?.collection, 'public-transcripts');
    assert.equal(episode.rows[0]?.status, 'ready');
    assert.equal(episode.rows[0]?.audio_url, 'https://cdn.example.com/audio.mp3');
    assert.equal(episode.rows[0]?.ad_plan?.intervals.length, 1);
    assert.equal(episode.rows[0]?.ad_plan?.audioVersion.length, version.length);
    const segments = await pool.query('SELECT text FROM transcript_segments WHERE episode_id=$1 ORDER BY start_seconds', [episodeId]);
    assert.deepEqual(segments.rows.map((row) => row.text), [
      'Welcome to the show.',
      'This episode is sponsored by Example Cloud.',
      'Now back to the interview.',
    ]);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
    await admin.end();
  }
});
