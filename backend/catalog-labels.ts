import type { PreparedEpisode } from '../shared/listening';

type Entry = Pick<PreparedEpisode, 'id' | 'title' | 'guest'>;
const short = (text: string, words = 9, limit = 64) => {
  const parts = text.replace(/[“”"\[\]{}]/g, '').trim().split(/\s+/).slice(0, words);
  while (parts.length > 1 && parts.join(' ').length > limit) parts.pop();
  return parts.join(' ').slice(0, limit);
};

// Labels are literal metadata excerpts, never model-invented episode titles.
// Retain the spoken label with its ID in pendingOffers for subsequent turns.
export function catalogLabels(episodes: Entry[]): Map<string, string> {
  const labels = new Map<string, string>();
  const used = new Set<string>();
  for (const episode of episodes) {
    const guest = episode.guest?.trim();
    const title = short(episode.title.split(/\s+[|—–]\s+|:\s+/)[0]!);
    let label = guest && guest.length <= 55 && guest.split(/\s+/).length <= 6 ? `${guest}’s episode` : title;
    if (used.has(label.toLowerCase())) label = guest ? `${title} with ${short(guest, 4, 32)}` : `${title}, option ${labels.size + 1}`;
    if (used.has(label.toLowerCase())) label = `${title}, option ${labels.size + 1}`;
    used.add(label.toLowerCase()); labels.set(episode.id, label);
  }
  return labels;
}
