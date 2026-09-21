import type { Evidence } from '../shared/listening';

export const LENNY_REVISION = '72b8ae5d2ad25d4ee0b78fc1bc65b088282b6dbc';
export const LENNY_REPOSITORY = 'https://raw.githubusercontent.com/LennysNewsletter/lennys-newsletterpodcastdata';
export const LENNY_FEED = 'https://api.substack.com/feed/podcast/10845.rss';
export type Chapter = { startSeconds: number; title: string };
export type AdBreak = { startSeconds: number; endSeconds: number; source: 'publisher-chapter' | 'reviewed-transcript' };

// Reviewed against this exact release: the sponsor read starts and ends on
// separate timed speaker turns. Sam Lessin's sponsor read ends mid-turn, so it
// deliberately has no marker. Never extend these to a different transcript.
const reviewedAds: Record<string, { hash: string; startSeconds: number; endSeconds: number }> = {
  'lenny-brian-halligan': { hash: 'ede70eb67f2af35f116680fa284ae3a82bb375b10848763e56d9ea31fdb8f76e', startSeconds: 2230, endSeconds: 2290 },
  'lenny-lazar-jovanovic': { hash: 'bc10411df2353bfc6ba4c6140b0a998355bde12f0968ae58a753d1f4bea6030d', startSeconds: 2997, endSeconds: 3058 },
};
export function reviewedAdBreaks(id: string, transcriptHash: string, passages: Evidence[]): AdBreak[] {
  const ad = reviewedAds[id];
  if (!ad || ad.hash !== transcriptHash || !passages.some((p) => p.startSeconds === ad.startSeconds) || !passages.some((p) => p.startSeconds === ad.endSeconds)) return [];
  return [{ startSeconds: ad.startSeconds, endSeconds: ad.endSeconds, source: 'reviewed-transcript' }];
}

export function seconds(value: string | number): number {
  const parts = String(value).split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) throw new Error('Invalid timestamp');
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** Preserve publisher timestamps; merge equal-time speaker turns without inventing timing. */
export function parseLennyTranscript(markdown: string, duration: number): Evidence[] {
  const headings = [...markdown.matchAll(/^\*\*(.+?)\*\*\s*\((\d{1,2}:\d{2}:\d{2})\):\s*$/gm)];
  if (!headings.length) throw new Error('No timed speaker turns found');
  const turns: { start: number; text: string }[] = [];
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i]!;
    const start = seconds(heading[2]!);
    if (start >= duration) throw new Error(`Transcript timestamp ${start} exceeds audio duration ${duration}`);
    const text = `${heading[1]}: ${markdown.slice(heading.index! + heading[0].length, headings[i + 1]?.index ?? markdown.length).trim()}`;
    turns.push({ start, text });
  }
  // Speakers can overlap; preserve their published start times and group ties.
  const ordered: typeof turns = [];
  for (const turn of turns.sort((a, b) => a.start - b.start)) {
    if (ordered.at(-1)?.start === turn.start) ordered.at(-1)!.text += `\n${turn.text}`;
    else ordered.push(turn);
  }
  return ordered.map((turn, i) => ({ id: `p${i}`, startSeconds: turn.start,
    endSeconds: ordered[i + 1]?.start ?? duration, text: turn.text }));
}

export function parseChapters(html: string): Chapter[] {
  const text = html.replace(/<[^>]*>/g, '\n').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'");
  const result: Chapter[] = [];
  for (const match of text.matchAll(/\((\d{1,2}:\d{2}(?::\d{2})?)\)\s*([^\n]+)/g)) {
    const startSeconds = seconds(match[1]!);
    if (result.length && startSeconds <= result.at(-1)!.startSeconds) continue;
    result.push({ startSeconds, title: match[2]!.trim() });
  }
  return result;
}

/** Never infer an advertisement from an interview discussing ads or monetization. */
export function publisherAdBreaks(chapters: Chapter[], duration: number): AdBreak[] {
  return chapters.flatMap((chapter, index) => {
    const end = chapters[index + 1]?.startSeconds;
    if (!/^(?:sponsors?\b|ad break\b|advertisement\b|a word from (?:our|the) sponsors?)/i.test(chapter.title) || !end || end > duration) return [];
    return [{ startSeconds: chapter.startSeconds, endSeconds: end, source: 'publisher-chapter' as const }];
  });
}
