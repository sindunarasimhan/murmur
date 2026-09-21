import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { transaction } from './database';
import { ObjectStore } from './storage';
import { parseLennyTranscript } from './lenny-catalog';

// Derived review metadata only. Publisher audio and raw transcripts remain local.
export const FOCUS_EPISODE_ID = 'lenny-brian-halligan';
export const FOCUS_AUDIO_SHA = '5d55b98600573b347a83c80f180ed22ff30032f05f897fa4a53206d4cf0e8303';
export const FOCUS_TRANSCRIPT_SHA = 'ede70eb67f2af35f116680fa284ae3a82bb375b10848763e56d9ea31fdb8f76e';
const AUDIO_URL = 'https://pscrb.fm/rss/p/api.substack.com/feed/podcast/187154837/0c611c6487a4ace2157de90893760367.mp3';
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

export async function prepareFocusEpisode(pool: Pool, objects: ObjectStore, sourceFile?: string) {
  const transcript = await readFile(new URL('../.murmur-data/lenny/lenny-brian-halligan.md', import.meta.url), 'utf8');
  if (digest(transcript) !== FOCUS_TRANSCRIPT_SHA) throw new Error('The focus transcript changed. Review the audio/transcript pair before enabling skips.');
  let audio: Buffer;
  try { audio = await objects.read(`${FOCUS_AUDIO_SHA}.mp3`); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    if (sourceFile) audio = await readFile(sourceFile);
    else {
      const response = await fetch(AUDIO_URL, { headers: { 'User-Agent': 'Murmur/0.1' }, signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) throw new Error(`Cannot prepare Brian’s audio: publisher HTTP ${response.status}.`);
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 100_000_000) { await response.body.cancel().catch(() => undefined); throw new Error('Publisher audio exceeds the preparation limit.'); }
        chunks.push(Buffer.from(chunk));
      }
      audio = Buffer.concat(chunks);
    }
  }
  if (digest(audio) !== FOCUS_AUDIO_SHA) throw new Error('Publisher audio changed. The reviewed ad markers cannot be used with this copy.');
  const key = await objects.put(audio, 'mp3');
  const segments = parseLennyTranscript(transcript, 4477);
  // Audio review: final sponsor word ends about 2289.80; the interview's
  // first word starts about 2290.46. Seek into that gap, preserving the sentence.
  const ads = [{ id: 'workos-midroll', startSeconds: 2230, endSeconds: 2290, audioVersion: FOCUS_AUDIO_SHA, source: 'audio-review' }];
  await transaction(pool, async (db) => {
    const episode = await db.query('SELECT id FROM episodes WHERE id=$1 FOR UPDATE', [FOCUS_EPISODE_ID]);
    if (!episode.rowCount) throw new Error('Import Brian’s episode metadata first.');
    await db.query('DELETE FROM transcript_segments WHERE episode_id=$1', [FOCUS_EPISODE_ID]);
    for (const segment of segments) await db.query(`INSERT INTO transcript_segments(episode_id,audio_version,id,start_seconds,end_seconds,text) VALUES($1,$2,$3,$4,$5,$6)`,
      [FOCUS_EPISODE_ID, FOCUS_AUDIO_SHA, segment.id, segment.startSeconds, segment.endSeconds, segment.text]);
    await db.query(`UPDATE episodes SET audio_key=$2,audio_url=NULL,audio_version=$3,duration_seconds=4477,ad_breaks=$4,status='ready',prepared_at=now() WHERE id=$1`,
      [FOCUS_EPISODE_ID, key, FOCUS_AUDIO_SHA, JSON.stringify(ads)]);
  });
}
