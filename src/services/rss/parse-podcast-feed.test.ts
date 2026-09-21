import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePodcastFeed, selectTranscriptSource } from './parse-podcast-feed';

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:pc="https://podcastindex.org/namespace/1.0">
  <channel>
    <title>Murmur Test Radio</title>
    <description>A feed for parser tests.</description>
    <language>en-US</language>
    <itunes:author>Murmur Labs</itunes:author>
    <itunes:image href="https://example.com/show.jpg" />
    <item>
      <guid>episode-1</guid>
      <title>Ideas in motion</title>
      <description><![CDATA[<p>A detailed <strong>conversation</strong>.</p>]]></description>
      <pubDate>Fri, 04 Sep 2026 15:00:00 GMT</pubDate>
      <itunes:duration>01:02:03</itunes:duration>
      <enclosure url="https://example.com/episode.mp3" type="audio/mpeg" />
      <pc:transcript url="https://example.com/transcript.txt" type="text/plain" />
      <pc:transcript url="https://example.com/transcript.vtt" type="text/vtt" language="en" />
    </item>
  </channel>
</rss>`;

test('parses episodes and alternate Podcasting 2.0 namespace prefixes', () => {
  const feed = parsePodcastFeed(rss, 'https://example.com/feed.xml');

  assert.equal(feed.title, 'Murmur Test Radio');
  assert.equal(feed.episodes.length, 1);
  assert.equal(feed.episodes[0]?.durationSeconds, 3723);
  assert.equal(feed.episodes[0]?.description, 'A detailed conversation.');
  assert.equal(feed.episodes[0]?.transcriptSources.length, 2);
  assert.equal(feed.episodes[0]?.transcriptSources[1]?.kind, 'vtt');
});

test('prefers a timed transcript in the requested language', () => {
  const feed = parsePodcastFeed(rss, 'https://example.com/feed.xml');
  const source = selectTranscriptSource(feed.episodes[0]?.transcriptSources ?? [], 'en');

  assert.equal(source?.kind, 'vtt');
  assert.equal(source?.url, 'https://example.com/transcript.vtt');
});

test('rejects XML documents with a doctype', () => {
  assert.throws(
    () => parsePodcastFeed('<!DOCTYPE rss><rss><channel /></rss>', 'https://example.com'),
    /DOCTYPE/,
  );
});

test('decodes XML entities in text and URL attributes without enabling document entities', () => {
  const encodedFeed = parsePodcastFeed(
    `<?xml version="1.0"?>
<rss version="2.0" xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <title>Ideas &amp; Evidence &#x2014; Daily</title>
    <description>Questions &lt; answers</description>
    <item>
      <guid>encoded-1</guid>
      <title>Research &amp; debate</title>
      <enclosure url="https://example.com/audio.mp3?one=1&amp;two=2" type="audio/mpeg" />
      <podcast:transcript url="transcript.vtt?one=1&amp;two=2" type="text/vtt" />
    </item>
  </channel>
</rss>`,
    'https://example.com/shows/feed.xml',
  );

  assert.equal(encodedFeed.title, 'Ideas & Evidence — Daily');
  assert.equal(encodedFeed.description, 'Questions < answers');
  assert.equal(encodedFeed.episodes[0]?.title, 'Research & debate');
  assert.equal(
    encodedFeed.episodes[0]?.audioAsset.url,
    'https://example.com/audio.mp3?one=1&two=2',
  );
  assert.equal(
    encodedFeed.episodes[0]?.transcriptSources[0]?.url,
    'https://example.com/shows/transcript.vtt?one=1&two=2',
  );
});

test('recognizes the legacy Podcasting 2.0 namespace URI under any prefix', () => {
  const legacyFeed = parsePodcastFeed(
    `<?xml version="1.0"?>
<rss version="2.0"
  xmlns:legacy="https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md">
  <channel>
    <title>Legacy Feed</title>
    <description>Compatibility fixture</description>
    <item>
      <guid>legacy-1</guid>
      <title>Legacy transcript</title>
      <enclosure url="https://example.com/legacy.mp3" type="audio/mpeg" />
      <legacy:transcript url="https://example.com/legacy.vtt" type="text/vtt" />
    </item>
  </channel>
</rss>`,
    'https://example.com/feed.xml',
  );

  assert.equal(legacyFeed.episodes[0]?.transcriptSources[0]?.kind, 'vtt');
});

test('prefers timed context over a language-exact plain transcript', () => {
  const source = selectTranscriptSource(
    [
      {
        url: 'https://example.com/exact.txt',
        mimeType: 'text/plain',
        language: 'en-US',
        kind: 'text',
        isTimed: false,
      },
      {
        url: 'https://example.com/timed.vtt',
        mimeType: 'text/vtt',
        kind: 'vtt',
        isTimed: true,
      },
    ],
    'en-US',
  );

  assert.equal(source?.url, 'https://example.com/timed.vtt');
});

test('rejects insecure remote media URLs while allowing HTTPS', () => {
  const insecureFeed = parsePodcastFeed(
    `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Secure Feed</title>
    <description>Only secure remote media is accepted.</description>
    <item>
      <guid>insecure-1</guid>
      <title>Insecure episode</title>
      <enclosure url="http://example.com/audio.mp3" type="audio/mpeg" />
    </item>
  </channel>
</rss>`,
    'https://example.com/feed.xml',
  );

  assert.equal(insecureFeed.episodes.length, 0);
});
