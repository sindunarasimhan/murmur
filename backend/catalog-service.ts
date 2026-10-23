import type { CatalogResolution, PreparedEpisode } from '../shared/listening';
import type { CatalogInterpreter } from './catalog-interpreter';
import type { Repository } from './repository';
import { ServiceError } from './errors';
import { fallbackResolution } from './catalog-fallback';
import { CatalogDiscoveryMemory, type DiscoveryState } from './catalog-discovery';

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
  constructor(private readonly repository: CatalogRepository, private readonly interpret: CatalogInterpreter,
    private readonly discovery = new CatalogDiscoveryMemory()) {}

  forget(owner: string) { this.discovery.forget(owner); }

  async resolve(owner: string, utterance: string, currentEpisodeId: string | undefined, history: string[], signal: AbortSignal): Promise<CatalogResolution> {
    signal.throwIfAborted();
    const turn = this.discovery.begin(owner, currentEpisodeId, history);
    const episodes = await this.repository.catalog();
    if (!episodes.length) {
      throw new ServiceError(503, 'catalog_preparing', 'The podcast catalog is being prepared. Please try again shortly.');
    }
    const current = episodes.find((episode) => episode.id === currentEpisodeId);
    await this.repository.charge(owner);
    const intent = await this.interpret({
      utterance,
      currentEpisodeId: current?.id,
      history: turn.history,
      discovery: turn.state,
      episodes: episodes.map(({ id, title, showTitle, guest, description, durationSeconds }) => ({ id, title, showTitle, guest, description, durationSeconds })),
    }, signal);
    turn.assertCurrent(signal);
    const finish = (result: CatalogResolution, state: DiscoveryState = turn.state): CatalogResolution => {
      if (result.kind === 'clarify') turn.commit(utterance, result.message, state, signal);
      else turn.clear(signal);
      return result;
    };

    switch (intent.kind) {
      case 'select': {
        const selected = episodes.find((episode) => episode.id === intent.episodeId);
        return finish(selected ? play(selected, intent.initialAction) : clarification(episodes));
      }
      case 'recommend':
        return finish(clarification(episodes));
      case 'resume': {
        if (current) return finish({ kind: 'current', message: '' });
        const unfinished = await this.repository.unfinished(owner);
        const selected = episodes.find((episode) => episode.id === unfinished?.id);
        if (selected) return finish(play(selected));
        return finish(clarification(episodes));
      }
      case 'current':
        return finish(current ? { kind: 'current', message: '' } : clarification(episodes));
      case 'stop':
        return finish({ kind: 'stop', message: 'Microphone off. See you soon.' });
      case 'home':
        return finish({ kind: 'home', message: 'Back home. What would you like to hear?' });
      case 'cancel':
        return finish({ kind: 'cancel', message: '' });
      case 'clarify':
        if (intent.fallback) return finish(fallbackResolution(episodes, intent.fallback), intent.fallback.discovery);
        return finish(clarification(episodes, intent.candidateIds, current, intent.reason), {
          ...turn.state,
          pendingOffers: intent.candidateIds.map((episodeId, index) => ({ option: index + 1, episodeId }))
            .filter(({ episodeId }) => episodes.some((episode) => episode.id === episodeId)),
          offeredEpisodeIds: [...new Set([...turn.state.offeredEpisodeIds, ...intent.candidateIds])].slice(-100),
        });
    }
  }
}
