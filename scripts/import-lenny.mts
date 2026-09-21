import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';
import { backendConfig } from '../backend/config';
import { createDatabase, migrate, transaction } from '../backend/database';
import { LENNY_FEED, LENNY_REPOSITORY, LENNY_REVISION, parseChapters, parseLennyTranscript, publisherAdBreaks, reviewedAdBreaks, seconds } from '../backend/lenny-catalog';
import { FOCUS_AUDIO_SHA, FOCUS_EPISODE_ID, prepareFocusEpisode } from '../backend/focus-episode';
import { ObjectStore } from '../backend/storage';

const directory = new URL('../.murmur-data/lenny/', import.meta.url);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
await mkdir(directory, { recursive: true });
async function cached(name: string, url: string, refresh = false) {
  const file = new URL(name, directory);
  if (!refresh) { try { return await readFile(file, 'utf8'); } catch { /* Initial import. */ } }
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Cannot import ${name}: HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 20_000_000) throw new Error('Import response is too large');
  await writeFile(file, text); return text;
}
const entrySchema = z.object({ title: z.string(), filename: z.string().regex(/^podcasts\/[a-z0-9_-]+\.md$/), date: z.string(), description: z.string(), guest: z.string(), post_url: z.url().optional() });
const index = z.object({ podcasts: z.array(entrySchema).length(50) }).parse(JSON.parse(await cached('index.json', `${LENNY_REPOSITORY}/${LENNY_REVISION}/index.json`)));
const feed = new XMLParser({ ignoreAttributes: false, processEntities: true }).parse(await cached('feed.xml', LENNY_FEED, process.argv.includes('--refresh'))).rss.channel;
const config = backendConfig();
const pool = createDatabase(config.databaseUrl);
try {
  await migrate(pool);
  let completed = 0;
  const selected = config.focusEpisodeId && !process.argv.includes('--all') ? index.podcasts.filter((entry) => `lenny-${entry.filename.slice(9, -3)}` === config.focusEpisodeId) : index.podcasts;
  for (const entry of selected) {
    const entryId = `lenny-${entry.filename.slice(9, -3)}`;
    if (entryId === FOCUS_EPISODE_ID && (await pool.query('SELECT 1 FROM episodes WHERE id=$1 AND audio_key=$2 AND audio_version=$3', [entryId, `${FOCUS_AUDIO_SHA}.mp3`, FOCUS_AUDIO_SHA])).rowCount) {
      console.log(`${++completed}/${selected.length} Brian Halligan: retaining reviewed audio.`); continue;
    }
    // The Alexander file's frontmatter labels a different How I AI interview.
    // Its speaker turns and 01:24:48 closing belong to the 85:13 Lenny interview.
    const corrections: Record<string, { source: string; description: string }> = {
      'podcasts/alexander-embiricos.md': { source: 'https://www.lennysnewsletter.com/p/why-humans-are-ais-biggest-bottleneck', description: 'Alexander Embiricos on Codex, the future of software engineering, and humans as the bottleneck in AI workflows.' },
      'podcasts/jason-m-lemkin.md': { source: 'https://www.lennysnewsletter.com/p/building-a-world-class-sales-org', description: 'Jason Lemkin on hiring sales leaders, building a sales organization, scaling SaaS, and founder-led sales.' },
      'podcasts/tomer-cohen.md': { source: 'https://www.lennysnewsletter.com/p/how-linkedin-became-interesting-tomer-cohen', description: 'Tomer Cohen on transforming the LinkedIn feed, clarity in product leadership, and an AI-first mindset.' },
    };
    const correction = corrections[entry.filename];
    const source = correction?.source ?? entry.post_url;
    const candidates = feed.item.filter((candidate: { link: string; title: string; pubDate: string; description: string }) =>
      source ? candidate.link?.replace(/\/$/, '') === source.replace(/\/$/, '')
        : candidate.title === entry.title || (new Date(candidate.pubDate).toISOString().slice(0, 10) === entry.date &&
          `${candidate.title} ${candidate.description}`.toLowerCase().includes(entry.guest.split(' ')[0]!.toLowerCase())));
    if (candidates.length !== 1) throw new Error(`Ambiguous public audio match for ${entry.guest}`);
    const item = candidates[0];
    if (!item?.enclosure?.['@_url']) throw new Error(`No public RSS audio for ${entry.guest}`);
    const audioUrl = new URL(item.enclosure['@_url']);
    if (audioUrl.protocol !== 'https:' || audioUrl.username || audioUrl.password) throw new Error('Unsafe publisher enclosure');
    const id = `lenny-${entry.filename.slice(9, -3)}`;
    const markdown = await cached(`${id}.md`, `${LENNY_REPOSITORY}/${LENNY_REVISION}/${entry.filename}`);
    const duration = seconds(item['itunes:duration']);
    const segments = parseLennyTranscript(markdown, duration);
    const chapters = parseChapters(item.description ?? '');
    const ads = [...publisherAdBreaks(chapters, duration), ...reviewedAdBreaks(id, hash(markdown), segments)];
    // Version the publisher enclosure and transcript together. This is provenance,
    // not a claim that the source timestamps have been audio-aligned by Murmur.
    const version = hash(JSON.stringify([audioUrl.href, item.enclosure['@_length'], duration, hash(markdown)]));
    await transaction(pool, async (db) => {
      await db.query(`INSERT INTO episodes(id,title,show_title,description,audio_version,duration_seconds,status,collection,guest,published_at,source_url,artwork_url,audio_url,chapters,ad_breaks,prepared_at)
        VALUES($1,$2,'Lenny’s Podcast',$3,$4,$5,'ready','lenny-free',$6,$7,$8,$9,$10,$11,$12,now())
        ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,audio_version=EXCLUDED.audio_version,duration_seconds=EXCLUDED.duration_seconds,
        audio_url=EXCLUDED.audio_url,artwork_url=EXCLUDED.artwork_url,guest=EXCLUDED.guest,published_at=EXCLUDED.published_at,source_url=EXCLUDED.source_url,
        chapters=EXCLUDED.chapters,ad_breaks=EXCLUDED.ad_breaks,status='ready',prepared_at=now()`,
      [id, item.title, correction?.description ?? entry.description, version, duration, id === 'lenny-noam-segal' ? 'Noam Segal' : entry.guest.replace(/\s+(?:V\d+|\d+\.\d+)$/, '').replace('Jason M Lemkin', 'Jason Lemkin'), new Date(item.pubDate).toISOString().slice(0, 10), item.link,
        item['itunes:image']?.['@_href'] ?? feed['itunes:image']?.['@_href'], audioUrl.href, JSON.stringify(chapters), JSON.stringify(ads)]);
      await db.query('DELETE FROM transcript_segments WHERE episode_id=$1', [id]);
      for (const segment of segments) await db.query(`INSERT INTO transcript_segments(episode_id,audio_version,id,start_seconds,end_seconds,text) VALUES($1,$2,$3,$4,$5,$6)`,
        [id, version, segment.id, segment.startSeconds, segment.endSeconds, segment.text]);
    });
    console.log(`${++completed}/${selected.length} ${entry.guest}: ${segments.length} passages, ${ads.length} transcript ad candidates`);
  }
  if (config.focusEpisodeId === FOCUS_EPISODE_ID) {
    const fileIndex = process.argv.indexOf('--audio-file');
    await prepareFocusEpisode(pool, new ObjectStore(config.objectDirectory), fileIndex >= 0 ? process.argv[fileIndex + 1] : undefined);
  }
  console.log('Lenny’s collection is ready. Raw source files remain in ignored local storage.');
} finally { await pool.end(); }
