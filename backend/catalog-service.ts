import type { CatalogResolution, PreparedEpisode } from '../shared/listening';
import type { CatalogInterpreter } from './catalog-interpreter';
import type { Repository } from './repository';
import { ServiceError } from './errors';
import { exactCommand } from './intelligence';

type CatalogRepository = Pick<Repository, 'catalog' | 'unfinished' | 'charge'>;

function play(episode: PreparedEpisode): CatalogResolution {
  const detail = episode.guest ? `With ${episode.guest}.` : episode.title;
  return { kind: 'play', episode, message: `${episode.showTitle}. ${detail}` };
}

function clarification(episodes: PreparedEpisode[], candidateIds: string[] = []): CatalogResolution {
  const candidates = [...new Set(candidateIds)]
    .map((id) => episodes.find((episode) => episode.id === id))
    .filter((episode): episode is PreparedEpisode => episode !== undefined);
  let message = 'Which show, guest, or topic would you like to hear?';
  if (candidates.length === 2) {
    message = `Did you mean “${candidates[0]!.title}” or “${candidates[1]!.title}”?`;
  } else if (episodes.length === 1) {
    const episode = episodes[0]!;
    message = `I have “${episode.title}” from ${episode.showTitle}. Would you like to play it?`;
  }
  return { kind: 'clarify', message };
}

export class CatalogService {
  constructor(private readonly repository: CatalogRepository, private readonly interpret: CatalogInterpreter) {}

  async resolve(owner: string, utterance: string, currentEpisodeId: string | undefined, history: string[], signal: AbortSignal): Promise<CatalogResolution> {
    signal.throwIfAborted();
    const episodes = await this.repository.catalog();
    if (!episodes.length) {
      throw new ServiceError(503, 'catalog_preparing', 'The podcast catalog is being prepared. Please try again shortly.');
    }
    const current = episodes.find((episode) => episode.id === currentEpisodeId);
    // Transport commands already have a deterministic implementation. They do
    // not select content and continue working when interpretation is unavailable.
    if (current && exactCommand(utterance)) return { kind: 'current', message: '' };

    await this.repository.charge(owner);
    const intent = await this.interpret({
      utterance,
      currentEpisodeId: current?.id,
      history,
      episodes: episodes.map(({ id, title, showTitle, guest, description }) => ({ id, title, showTitle, guest, description })),
    }, signal);
    signal.throwIfAborted();

    switch (intent.kind) {
      case 'select': {
        const selected = episodes.find((episode) => episode.id === intent.episodeId);
        return selected ? play(selected) : clarification(episodes);
      }
      case 'resume': {
        if (current) return { kind: 'current', message: '' };
        const unfinished = await this.repository.unfinished(owner);
        const selected = episodes.find((episode) => episode.id === unfinished?.id);
        if (selected) return play(selected);
        return episodes.length === 1 ? play(episodes[0]!) : clarification(episodes);
      }
      case 'current':
        return current ? { kind: 'current', message: '' } : clarification(episodes);
      case 'stop':
        return { kind: 'stop', message: 'Microphone off. See you soon.' };
      case 'home':
        return { kind: 'home', message: 'Back home. What would you like to hear?' };
      case 'clarify':
        return clarification(episodes, intent.candidateIds);
    }
  }
}
