import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { PodcastEpisode, PodcastFeed, TranscriptCue } from '../src/domain/podcast';
import { parsePodcastFeed, selectTranscriptSource } from '../src/services/rss/parse-podcast-feed';
import { parseTranscript } from '../src/services/rss/parse-transcript';
import type { Evidence } from '../shared/listening';
import { validatedAdPlan } from '../shared/ad-plan';
import { transaction } from './database';
import { createAdClassifier, preprocessAds, type AdClassifier } from './ad-preprocessing';
import type { BackendConfig } from './config';

const MAX_FEED_BYTES = 10 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

export type PublicTranscriptCandidate = {
  label: string;
  query?: string;
  feedUrl?: string;
};

export type PublicTranscriptAudit = {
  label: string;
  feedUrl?: string;
  feedTitle?: string;
  totalEpisodes: number;
  timedTranscriptEpisodes: number;
  importedEpisodes: number;
  skippedReason?: string;
};

export type PublicTranscriptImportResult = PublicTranscriptAudit & {
  episodeIds: string[];
};

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseSafeHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    if (url.protocol === 'https:') return url;
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return url;
    return undefined;
  } catch {
    return undefined;
  }
}

async function fetchText(url: string, maxBytes: number, fetcher: typeof fetch, signal?: AbortSignal): Promise<string> {
  const parsed = parseSafeHttpUrl(url);
  if (!parsed) throw new Error('Only public HTTPS resources can be imported.');
  const response = await fetcher(parsed.toString(), {
    redirect: 'follow',
    headers: {
      Accept: 'application/rss+xml, application/xml, text/xml, text/vtt, application/x-subrip, application/json, text/plain',
      'User-Agent': 'MurmurPublicTranscriptImporter/0.1',
    },
    signal,
  });
  if (!response.ok) throw new Error(`Public resource returned HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new Error('Public resource is too large.');
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) throw new Error('Public resource is too large.');
  return text;
}

export async function loadPublicTranscriptFeed(feedUrl: string, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<PodcastFeed> {
  return parsePodcastFeed(await fetchText(feedUrl, MAX_FEED_BYTES, fetcher, signal), feedUrl);
}

function durationFor(episode: PodcastEpisode, cues: readonly TranscriptCue[]): number {
  const transcriptEnd = cues.reduce((end, cue) => Math.max(end, cue.endSeconds), 0);
  return Math.max(episode.durationSeconds ?? 0, transcriptEnd);
}

function normalizedSegments(cues: readonly TranscriptCue[], durationSeconds: number): Evidence[] {
  let previousEnd = 0;
  return cues.flatMap((cue, index) => {
    const startSeconds = Math.max(0, cue.startSeconds, previousEnd);
    const endSeconds = Math.min(durationSeconds, cue.endSeconds);
    const text = `${cue.speaker ? `${cue.speaker}: ` : ''}${cue.text}`.trim();
    if (!text || !Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) return [];
    previousEnd = endSeconds;
    return [{ id: `cue-${index}`, startSeconds, endSeconds, text }];
  });
}

export function publicEpisodeId(feed: PodcastFeed, episode: PodcastEpisode): string {
  const feedPart = feed.id.replace(/[^a-z0-9_-]/gi, '').toLowerCase().slice(0, 32) || 'feed';
  const episodePart = episode.id.replace(/[^a-z0-9_-]/gi, '').toLowerCase().slice(0, 32) || hash(episode.guid).slice(0, 12);
  return `public-${feedPart}-${episodePart}`.slice(0, 128);
}

async function prepareEpisodeRecord(input: {
  feed: PodcastFeed;
  episode: PodcastEpisode;
  transcriptText: string;
  transcriptUrl: string;
}) {
  const { feed, episode, transcriptText, transcriptUrl } = input;
  const source = selectTranscriptSource(episode.transcriptSources.filter((candidate) => candidate.isTimed), 'en');
  if (!source) throw new Error('No timed transcript source.');
  const cues = parseTranscript(transcriptText, source);
  const durationSeconds = durationFor(episode, cues);
  const segments = normalizedSegments(cues, durationSeconds);
  if (!segments.length) throw new Error('Timed transcript could not be mapped to the episode timeline.');
  const audioVersion = hash(JSON.stringify([
    episode.audioAsset.url,
    episode.audioAsset.byteLength ?? null,
    episode.audioAsset.versionId,
    transcriptUrl,
    hash(transcriptText),
    durationSeconds,
  ]));
  return { id: publicEpisodeId(feed, episode), audioVersion, durationSeconds, segments };
}

export async function importPublicTranscriptFeed(input: {
  pool: Pool;
  config: BackendConfig;
  label: string;
  feedUrl: string;
  limit: number;
  fetch?: typeof fetch;
  classifyAds?: AdClassifier;
  dryRun?: boolean;
  signal?: AbortSignal;
}): Promise<PublicTranscriptImportResult> {
  const fetcher = input.fetch ?? fetch;
  const feed = await loadPublicTranscriptFeed(input.feedUrl, fetcher, input.signal);
  const withTranscript = feed.episodes.filter((episode) => selectTranscriptSource(episode.transcriptSources.filter((candidate) => candidate.isTimed), 'en'));
  const selected = withTranscript.slice(0, input.limit);
  const episodeIds: string[] = [];
  for (const episode of selected) {
    input.signal?.throwIfAborted();
    const source = selectTranscriptSource(episode.transcriptSources.filter((candidate) => candidate.isTimed), 'en');
    if (!source) continue;
    const transcriptText = await fetchText(source.url, MAX_TRANSCRIPT_BYTES, fetcher, input.signal);
    const prepared = await prepareEpisodeRecord({ feed, episode, transcriptText, transcriptUrl: source.url });
    let adPlan = null;
    if (!input.dryRun) {
      const existing = await input.pool.query('SELECT ad_plan FROM episodes WHERE id=$1 AND audio_version=$2', [prepared.id, prepared.audioVersion]);
      adPlan = validatedAdPlan(existing.rows[0]?.ad_plan, prepared.audioVersion, prepared.durationSeconds);
    }
    if (!adPlan) {
      try {
        adPlan = await preprocessAds(
          { audioVersion: prepared.audioVersion, durationSeconds: prepared.durationSeconds, segments: prepared.segments },
          input.classifyAds ?? createAdClassifier(input.config),
          input.signal,
        );
      } catch {
        adPlan = null;
      }
    }
    if (!input.dryRun) {
      await transaction(input.pool, async (db) => {
        await db.query(`INSERT INTO episodes(id,title,show_title,description,audio_version,duration_seconds,status,collection,guest,published_at,source_url,artwork_url,audio_url,ad_plan,prepared_at)
          VALUES($1,$2,$3,$4,$5,$6,'ready','public-transcripts',NULL,$7,$8,$9,$10,$11,now())
          ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,show_title=EXCLUDED.show_title,description=EXCLUDED.description,
            audio_version=EXCLUDED.audio_version,duration_seconds=EXCLUDED.duration_seconds,audio_url=EXCLUDED.audio_url,
            artwork_url=EXCLUDED.artwork_url,published_at=EXCLUDED.published_at,source_url=EXCLUDED.source_url,
            ad_plan=EXCLUDED.ad_plan,status='ready',prepared_at=now()`,
        [prepared.id, episode.title, feed.title, episode.description || feed.description, prepared.audioVersion, prepared.durationSeconds,
          episode.publishedAt ? new Date(episode.publishedAt).toISOString().slice(0, 10) : null, episode.guid || episode.audioAsset.url,
          episode.artworkUrl ?? feed.artworkUrl ?? null, episode.audioAsset.url, adPlan ? JSON.stringify(adPlan) : null]);
        await db.query('DELETE FROM transcript_segments WHERE episode_id=$1', [prepared.id]);
        for (const segment of prepared.segments) {
          await db.query(`INSERT INTO transcript_segments(episode_id,audio_version,id,start_seconds,end_seconds,text)
            VALUES($1,$2,$3,$4,$5,$6)`, [prepared.id, prepared.audioVersion, segment.id, segment.startSeconds, segment.endSeconds, segment.text]);
        }
      });
    }
    episodeIds.push(prepared.id);
  }
  return {
    label: input.label,
    feedUrl: feed.feedUrl,
    feedTitle: feed.title,
    totalEpisodes: feed.episodes.length,
    timedTranscriptEpisodes: withTranscript.length,
    importedEpisodes: episodeIds.length,
    episodeIds,
  };
}
