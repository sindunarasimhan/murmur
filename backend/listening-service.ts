import type { TurnRequest, TurnResult } from '../shared/listening';
import { Repository } from './repository';
import { playbackAction, type Intelligence } from './intelligence';
import { ServiceError } from './errors';

export class ListeningService {
  private active = new Map<string, AbortController>();
  constructor(private readonly repository: Repository, private readonly intelligence: Intelligence) {}
  cancel(sessionId: string) { this.active.get(sessionId)?.abort(); }
  close() { for (const controller of this.active.values()) controller.abort(); }
  async turn(owner: string, sessionId: string, input: TurnRequest, callerSignal?: AbortSignal): Promise<TurnResult> {
    const reserved = await this.repository.reserveTurn(owner, sessionId, input);
    if (reserved.cached) return reserved.cached;
    this.cancel(sessionId);
    const controller = new AbortController();
    this.active.set(sessionId, controller);
    const cancel = () => controller.abort();
    callerSignal?.addEventListener('abort', cancel, { once: true });
    if (callerSignal?.aborted) cancel();
    const timeout = setTimeout(cancel, 22_000);
    const { session } = reserved;
    try {
      controller.signal.throwIfAborted();
      const [episode, candidates, history] = await Promise.all([
        this.repository.episode(session.episodeId), this.repository.evidence(session, input.utterance), this.repository.history(sessionId),
      ]);
      const decision = await this.intelligence.decide({ utterance: input.utterance, session, evidence: candidates, history }, controller.signal);
      controller.signal.throwIfAborted();
      let action = playbackAction(decision, session, episode.durationSeconds);
      let adResult: Awaited<ReturnType<Repository['currentAd']>> | undefined;
      if (decision.kind === 'skip-ad') {
        adResult = await this.repository.currentAd(session);
        if (adResult.kind === 'skip') action = { ...playbackAction({ kind: 'seek', source: 'code', position: adResult.ad.endSeconds }, session, episode.durationSeconds)!, kind: 'skip-ad' };
      }
      if (decision.kind === 'topic' && decision.passageId) {
        const passage = candidates.find((item) => item.id === decision.passageId);
        if (passage) action = playbackAction({ kind: 'seek', source: 'jev', delta: passage.startSeconds - session.positionSeconds }, session, episode.durationSeconds);
      }
      if (action && ['seek', 'skip-ad'].includes(action.kind)) action.play = input.resumeAfterAction ?? true;
      let answer = '';
      let evidence = candidates.filter((item) => item.id === decision.passageId);
      if (!action) {
        if (decision.kind === 'skip-ad') answer = adResult?.kind === 'outside-ad' ? 'There isn’t an ad to skip at this point.' : 'I can’t verify an ad ending here. You can tell me how many seconds to skip.';
        else if (decision.kind === 'unclear') answer = 'Would you like an explanation, or a playback action?';
        else if (!evidence.length) answer = 'I do not have a matching passage for that question. Try asking about the part we just heard.';
        else {
          // Include nearby retrieved passages to preserve qualifying context.
          evidence = [evidence[0]!, ...candidates.filter((item) => item.id !== decision.passageId).slice(0, 2)];
          answer = await this.intelligence.answer({ utterance: input.utterance, decision, episode, session, evidence, history }, controller.signal);
        }
      }
      controller.signal.throwIfAborted();
      return await this.repository.completeTurn(owner, session, input.requestId, { answer, evidence, action, decision: decision.source, followUp: decision.kind !== 'skip-ad' || adResult?.kind === 'unverified' });
    } catch (error) {
      await this.repository.failTurn(session, input.requestId, controller.signal.aborted ? 'cancelled' : 'provider_error');
      if (controller.signal.aborted) throw new ServiceError(409, 'turn_cancelled', 'That request was stopped. Your place is saved.');
      throw error;
    } finally {
      clearTimeout(timeout);
      callerSignal?.removeEventListener('abort', cancel);
      if (this.active.get(sessionId) === controller) this.active.delete(sessionId);
    }
  }
}
