import { XMLParser } from 'fast-xml-parser';

import type {
  PodcastEpisode,
  PodcastFeed,
  TranscriptKind,
  TranscriptSource,
} from '@/domain/podcast';

const PODCAST_NAMESPACE = 'https://podcastindex.org/namespace/1.0';
const LEGACY_PODCAST_NAMESPACE_FRAGMENT =
  'github.com/Podcastindex-org/podcast-namespace';
const MAX_FEED_CHARACTERS = 10_000_000;

type XmlNode = Record<string, unknown>;

const parser = new XMLParser({
  attributeNamePrefix: '@_',
  ignoreAttributes: false,
  parseTagValue: false,
  processEntities: false,
  trimValues: true,
});

function asNode(value: unknown): XmlNode | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as XmlNode)
    : undefined;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([\da-f]+);/gi, (match, hexadecimal: string) => {
      const codePoint = Number.parseInt(hexadecimal, 16);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    })
    .replace(/&#(\d+);/g, (match, decimal: string) => {
      const codePoint = Number.parseInt(decimal, 10);
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    })
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = decodeXmlEntities(String(value).trim());
    return text || undefined;
  }

  const node = asNode(value);
  if (!node) return undefined;

  return readString(node['#text']) ?? readString(node['__cdata']);
}

function readAttribute(node: unknown, attribute: string): string | undefined {
  return readString(asNode(node)?.[`@_${attribute}`]);
}

function readHttpUrl(
  value: string | undefined,
  baseUrl: string,
): string | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value, baseUrl);
    const localHttp =
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    return url.protocol === 'https:' || localHttp ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function stripMarkup(value: string | undefined): string {
  if (!value) return '';

  return value
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .trim();
}

function parseDuration(value: string | undefined): number | undefined {
  if (!value) return undefined;

  const parts = value.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return undefined;
  const [first = 0, second = 0, third = 0] = parts;

  if (parts.length === 1) return first;
  if (parts.length === 2) return first * 60 + second;
  if (parts.length === 3) return first * 3600 + second * 60 + third;
  return undefined;
}

function transcriptKind(mimeType: string, url: string): TranscriptKind {
  const normalizedType = mimeType.toLowerCase();
  const normalizedUrl = url.toLowerCase().split('?')[0] ?? url.toLowerCase();

  if (normalizedType.includes('vtt') || normalizedUrl.endsWith('.vtt')) return 'vtt';
  if (
    normalizedType.includes('subrip') ||
    normalizedType.includes('srt') ||
    normalizedUrl.endsWith('.srt')
  ) {
    return 'srt';
  }
  if (normalizedType.includes('json') || normalizedUrl.endsWith('.json')) return 'json';
  if (
    normalizedType.includes('text/plain') ||
    normalizedType.includes('text/html') ||
    normalizedUrl.endsWith('.txt') ||
    normalizedUrl.endsWith('.html')
  ) {
    return 'text';
  }
  return 'unknown';
}

function findPodcastPrefix(rss: XmlNode): string {
  const entry = Object.entries(rss).find(
    ([key, value]) => {
      const namespace = readString(value)?.replace(/\/$/, '');
      return (
        key.startsWith('@_xmlns:') &&
        (namespace === PODCAST_NAMESPACE || namespace?.includes(LEGACY_PODCAST_NAMESPACE_FRAGMENT))
      );
    },
  );

  return entry?.[0].replace('@_xmlns:', '') ?? 'podcast';
}

function readTranscriptSources(
  item: XmlNode,
  podcastPrefix: string,
  feedUrl: string,
  feedLanguage?: string,
): TranscriptSource[] {
  const candidates = asArray(item[`${podcastPrefix}:transcript`]);

  return candidates.flatMap((candidate) => {
    const url = readHttpUrl(readAttribute(candidate, 'url'), feedUrl);
    const mimeType = readAttribute(candidate, 'type');
    if (!url || !mimeType) return [];

    const kind = transcriptKind(mimeType, url);
    return [
      {
        url,
        mimeType,
        language: readAttribute(candidate, 'language') ?? feedLanguage,
        relation: readAttribute(candidate, 'rel'),
        kind,
        isTimed: kind === 'vtt' || kind === 'srt' || kind === 'json',
      },
    ];
  });
}

function stableId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(36);
}

function readArtwork(node: XmlNode, feedUrl: string): string | undefined {
  return readHttpUrl(
    readAttribute(node['itunes:image'], 'href') ??
      readAttribute(node['podcast:image'], 'href') ??
      readString(asNode(node.image)?.url),
    feedUrl,
  );
}

function parseEpisode(
  rawItem: unknown,
  feed: Pick<PodcastFeed, 'artworkUrl' | 'feedUrl' | 'language' | 'title'>,
  podcastPrefix: string,
): PodcastEpisode | undefined {
  const item = asNode(rawItem);
  if (!item) return undefined;

  const audioUrl = readHttpUrl(readAttribute(item.enclosure, 'url'), feed.feedUrl);
  const audioMimeType = readAttribute(item.enclosure, 'type');
  const audioByteLength = Number(readAttribute(item.enclosure, 'length'));
  const title = readString(item.title);
  if (!audioUrl || !title) return undefined;

  const guid = readString(item.guid) ?? audioUrl;
  const published = readString(item.pubDate);
  const publishedDate = published ? new Date(published) : undefined;

  return {
    id: stableId(`${feed.feedUrl}|${guid}`),
    guid,
    podcastTitle: feed.title,
    title,
    description: stripMarkup(
      readString(item['content:encoded']) ??
        readString(item.description) ??
        readString(item['itunes:summary']),
    ),
    publishedAt:
      publishedDate && !Number.isNaN(publishedDate.valueOf())
        ? publishedDate.toISOString()
        : undefined,
    durationSeconds: parseDuration(readString(item['itunes:duration'])),
    audioAsset: {
      url: audioUrl,
      mimeType: audioMimeType,
      byteLength:
        Number.isFinite(audioByteLength) && audioByteLength > 0
          ? audioByteLength
          : undefined,
      identityKind: 'feed-locator',
      versionId: stableId(`${feed.feedUrl}|${guid}|${audioUrl}|${audioByteLength || ''}`),
    },
    artworkUrl: readArtwork(item, feed.feedUrl) ?? feed.artworkUrl,
    transcriptSources: readTranscriptSources(
      item,
      podcastPrefix,
      feed.feedUrl,
      feed.language,
    ),
    adSegments: [],
  };
}

export function parsePodcastFeed(xml: string, feedUrl: string): PodcastFeed {
  if (!xml.trim()) throw new Error('The RSS feed was empty.');
  if (xml.length > MAX_FEED_CHARACTERS) throw new Error('The RSS feed is too large.');
  if (/<!DOCTYPE/i.test(xml)) throw new Error('RSS feeds with a DOCTYPE are not supported.');

  const document = asNode(parser.parse(xml));
  const rss = asNode(document?.rss);
  const channel = asNode(rss?.channel);
  if (!rss || !channel) throw new Error('The document is not a supported RSS podcast feed.');

  const title = readString(channel.title);
  if (!title) throw new Error('The RSS feed does not have a title.');

  const language = readString(channel.language);
  const artworkUrl = readArtwork(channel, feedUrl);
  const podcastPrefix = findPodcastPrefix(rss);
  const episodes = asArray(channel.item)
    .map((item) =>
      parseEpisode(
        item,
        { artworkUrl, feedUrl, language, title },
        podcastPrefix,
      ),
    )
    .filter((episode): episode is PodcastEpisode => Boolean(episode))
    .sort((left, right) => {
      const leftTime = left.publishedAt ? Date.parse(left.publishedAt) : 0;
      const rightTime = right.publishedAt ? Date.parse(right.publishedAt) : 0;
      return rightTime - leftTime;
    });

  return {
    id: stableId(feedUrl),
    feedUrl,
    title,
    description: stripMarkup(readString(channel.description)),
    author: readString(channel['itunes:author']) ?? readString(channel.author),
    copyright: readString(channel.copyright),
    license: readString(channel[`${podcastPrefix}:license`]),
    language,
    artworkUrl,
    episodes,
  };
}

export function selectTranscriptSource(
  sources: TranscriptSource[],
  preferredLanguage = 'en',
): TranscriptSource | undefined {
  const language = preferredLanguage.toLowerCase();
  const languageBase = language.split('-')[0];
  const rankedKinds: TranscriptKind[] = ['vtt', 'srt', 'json', 'text', 'unknown'];

  const languageRank = (candidate?: string) => {
    if (!candidate) return 2;
    const normalized = candidate.toLowerCase();
    if (normalized === language) return 0;
    if (normalized.split('-')[0] === languageBase) return 1;
    return 3;
  };

  return [...sources].sort((left, right) => {
    if (left.isTimed !== right.isTimed) return left.isTimed ? -1 : 1;
    const leftLanguage = languageRank(left.language);
    const rightLanguage = languageRank(right.language);
    if (leftLanguage !== rightLanguage) return leftLanguage - rightLanguage;
    return rankedKinds.indexOf(left.kind) - rankedKinds.indexOf(right.kind);
  })[0];
}
