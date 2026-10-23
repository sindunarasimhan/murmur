import type { CatalogResolution, PreparedEpisode } from '../shared/listening';
import type { CatalogInterpreter } from './catalog-interpreter';
import type { Repository } from './repository';
import { ServiceError } from './errors';
import { fallbackResolution } from './catalog-fallback';

type CatalogRepository = Pick<Repository, 'catalog' | 'unfinished' | 'charge'>;

function play(episode: PreparedEpisode, initialAction?: 'restart' | 'enable-ad-skipping' | 'skip-intro'): CatalogResolution {
  const detail = episode.guest ? `With ${episode.guest}.` : episode.title;
  return { kind: 'play', episode, message: `${episode.showTitle}. ${detail}`, initialAction };
}

function clarification(episodes: PreparedEpisode[], candidateIds: string[] = [], current?: PreparedEpisode, reason?: 'unavailable'): CatalogResolution {
  const candidates = [...new Set(candidateIds)]
    .map((id) => episodes.find((episode) => episode.id === id))
    .filter((episode): episode is PreparedEpisode => episode !== undefined);
  let message = 'Which show, guest, or topic would you like to hear?';
  if (reason === 'unavailable' && candidates.length >= 2) {
    message = `I couldn’t find that in the catalog. I can play “${candidates[0]!.title}” or “${candidates[1]!.title}” instead.`;
  } else if (reason === 'unavailable') {
    message = candidates.length === 1
      ? `I couldn’t find that in the catalog. I can play “${candidates[0]!.title}” instead.`
      : 'I couldn’t find that in the catalog. Try a different show, guest, or topic.';
  } else if (candidates.length === 2) {
    message = `Did you mean “${candidates[0]!.title}” or “${candidates[1]!.title}”?`;
  } else if (current) {
    message = 'Could you repeat what you would like me to do with this episode?';
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
    await this.repository.charge(owner);
    const intent = await this.interpret({
      utterance,
      currentEpisodeId: current?.id,
      history,
      episodes: episodes.map(({ id, title, showTitle, guest, description, durationSeconds }) => ({ id, title, showTitle, guest, description, durationSeconds })),
    }, signal);
    signal.throwIfAborted();

    switch (intent.kind) {
      case 'select': {
        const selected = episodes.find((episode) => episode.id === intent.episodeId);
        return selected ? play(selected, intent.initialAction) : clarification(episodes);
      }
      case 'recommend':
        return fallbackResolution(episodes, { question: 'topic', candidateIds: [] });
      case 'resume': {
        if (current) return { kind: 'current', message: '' };
        const unfinished = await this.repository.unfinished(owner);
        const selected = episodes.find((episode) => episode.id === unfinished?.id);
        if (selected) return play(selected);
        return clarification(episodes);
      }
      case 'current':
        return current ? { kind: 'current', message: '' } : clarification(episodes);
      case 'stop':
        return { kind: 'stop', message: 'Microphone off. See you soon.' };
      case 'home':
        return { kind: 'home', message: 'Back home. What would you like to hear?' };
      case 'cancel':
        return { kind: 'cancel', message: '' };
      case 'clarify':
        if (intent.fallback) return fallbackResolution(episodes, intent.fallback, intent.reason === 'unavailable');
        return clarification(episodes, intent.candidateIds, current, intent.reason);
    }
  }
}
