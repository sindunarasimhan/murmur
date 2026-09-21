import { SERVER_BUDGETS, type ServerConfig } from '../config';
import { askChoices } from '../typesafe/client';
import { UpstreamError } from '../http/upstream';
import type { ExploreRequest } from './explore-contract';
import { EXPLORE_QUESTIONS, selectExploreRoute } from './decision-policy';
import { requestOpenAIExploreAnswer } from './openai-responses';

export async function answerQuestion(input: ExploreRequest, options: {
  config: ServerConfig; fetch?: typeof fetch; signal: AbortSignal;
}) {
  const { config, signal } = options;
  let route: { intent: ExploreRequest['intent']; simple: boolean; source: 'jev' | 'fallback' } = {
    intent: input.intent, simple: false, source: 'fallback',
  };
  if (config.typesafe.apiKey) {
    try {
      const answers = await askChoices({
        question: input.question, episode: input.episode,
        excerpt: input.transcriptContext, previousTurns: input.history ?? [],
      }, EXPLORE_QUESTIONS, {
        ...config.typesafe, apiKey: config.typesafe.apiKey, fetch: options.fetch,
        signal, timeoutMs: SERVER_BUDGETS.decision,
      });
      route = selectExploreRoute(input, answers);
    } catch (error) {
      // Jev is optional, but cancellation must never start another paid call.
      if (signal.aborted || (error instanceof UpstreamError && error.kind === 'cancelled')) throw new UpstreamError('cancelled');
      console.info('Murmur decision fallback', { reason: error instanceof UpstreamError ? error.kind : 'invalid' });
    }
  }
  const result = await requestOpenAIExploreAnswer({ ...input, intent: route.intent }, {
    apiKey: config.openai.apiKey!, model: route.simple ? config.openai.fastAnswerModel : config.openai.answerModel,
    fetchImpl: options.fetch, signal,
  });
  return { ...result, decision: route.source };
}
