import { backendConfig } from '../backend/config';
import { createDatabase, migrate } from '../backend/database';
import { importPublicTranscriptFeed, loadPublicTranscriptFeed, type PublicTranscriptCandidate } from '../backend/public-transcript-ingest';
import { selectTranscriptSource } from '../src/services/rss/parse-podcast-feed';

const popularCandidates: PublicTranscriptCandidate[] = [
  { label: 'The Joe Rogan Experience', query: 'The Joe Rogan Experience' },
  { label: 'All-In Podcast', query: 'All-In Podcast' },
  { label: 'Lenny’s Podcast', query: "Lenny's Podcast" },
  { label: 'Acquired', query: 'Acquired' },
  { label: 'Lex Fridman Podcast', query: 'Lex Fridman Podcast' },
  { label: 'Huberman Lab', query: 'Huberman Lab' },
  { label: 'The Daily', query: 'The Daily' },
  { label: 'Hard Fork', query: 'Hard Fork' },
  { label: 'Decoder', query: 'Decoder with Nilay Patel' },
  { label: 'Planet Money', query: 'Planet Money' },
  { label: 'Freakonomics Radio', query: 'Freakonomics Radio' },
  { label: 'This American Life', query: 'This American Life' },
  { label: 'How I Built This', query: 'How I Built This' },
  { label: '99% Invisible', query: '99% Invisible' },
  { label: 'The Ezra Klein Show', query: 'The Ezra Klein Show' },
];

const transcriptRichCandidates: PublicTranscriptCandidate[] = [
  { label: 'Podnews Daily', feedUrl: 'https://podnews.net/rss' },
  { label: 'Podnews Weekly Review', feedUrl: 'https://rss.buzzsprout.com/1538779.rss' },
  { label: 'Podcasting 2.0', feedUrl: 'https://feeds.podcastindex.org/pc20.xml' },
  { label: 'No Agenda Show', feedUrl: 'https://feeds.noagendaassets.com/noagenda.xml' },
  { label: 'Linux Unplugged', feedUrl: 'https://feeds.jupiterbroadcasting.com/lup' },
  { label: 'Talk Python To Me', feedUrl: 'https://talkpython.fm/episodes/rss' },
  { label: 'Python Bytes', feedUrl: 'https://pythonbytes.fm/episodes/rss' },
  { label: 'Oxide and Friends', feedUrl: 'https://feeds.transistor.fm/oxide-and-friends' },
];

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run') || args.has('--audit-only');
const includeTranscriptRich = !args.has('--popular-only');
const includePopular = !args.has('--transcript-rich-only');
const limit = Number(process.argv.find((arg) => arg.startsWith('--episodes='))?.split('=')[1] ?? 3);

function countTimed(feed: Awaited<ReturnType<typeof loadPublicTranscriptFeed>>) {
  return feed.episodes.filter((episode) => selectTranscriptSource(episode.transcriptSources.filter((candidate) => candidate.isTimed), 'en')).length;
}

async function resolveFeedUrl(candidate: PublicTranscriptCandidate, signal: AbortSignal): Promise<string | undefined> {
  if (candidate.feedUrl) return candidate.feedUrl;
  if (!candidate.query) return undefined;
  const url = new URL('https://itunes.apple.com/search');
  url.search = new URLSearchParams({ country: 'US', media: 'podcast', entity: 'podcast', limit: '1', term: candidate.query }).toString();
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  if (!response.ok) throw new Error(`Directory lookup failed with HTTP ${response.status}`);
  const payload = await response.json() as { results?: { feedUrl?: unknown }[] };
  const feedUrl = payload.results?.[0]?.feedUrl;
  return typeof feedUrl === 'string' ? feedUrl : undefined;
}

const config = backendConfig();
const pool = createDatabase(config.databaseUrl);
const controller = new AbortController();
const candidates = [
  ...(includePopular ? popularCandidates : []),
  ...(includeTranscriptRich ? transcriptRichCandidates : []),
];

try {
  await migrate(pool);
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const feedUrl = await resolveFeedUrl(candidate, controller.signal);
    if (!feedUrl || seen.has(feedUrl)) continue;
    seen.add(feedUrl);
    try {
      const feed = await loadPublicTranscriptFeed(feedUrl, fetch, controller.signal);
      const timed = countTimed(feed);
      if (!timed) {
        console.log(JSON.stringify({ label: candidate.label, feedTitle: feed.title, feedUrl, totalEpisodes: feed.episodes.length, timedTranscriptEpisodes: 0, importedEpisodes: 0, skippedReason: 'no-public-timed-transcripts' }));
        continue;
      }
      const result = await importPublicTranscriptFeed({ pool, config, label: candidate.label, feedUrl, limit, dryRun, signal: controller.signal });
      console.log(JSON.stringify(result));
    } catch (error) {
      console.log(JSON.stringify({ label: candidate.label, feedUrl, totalEpisodes: 0, timedTranscriptEpisodes: 0, importedEpisodes: 0, skippedReason: error instanceof Error ? error.message : 'failed' }));
    }
  }
} finally {
  await pool.end();
}
