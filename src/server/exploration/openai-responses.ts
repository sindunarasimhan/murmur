import { DEFAULT_MODELS, SERVER_BUDGETS } from '../config';
import { isRecord, readUpstreamJson, requestUpstream, UpstreamError } from '../http/upstream';
import type { ExploreRequest } from './explore-contract';
import { buildExploreInput, EXPLORE_SYSTEM_INSTRUCTIONS } from './explore-prompt';

export const DEFAULT_OPENAI_RESPONSE_MODEL = DEFAULT_MODELS.answer;
export type OpenAIExploreResult = { answer: string; model: string };

function extractAnswer(payload: Record<string, unknown>): string {
  // Never present a truncated or failed generation as a complete answer.
  if (payload.status !== undefined && payload.status !== 'completed') throw new UpstreamError('invalid');
  if (typeof payload.output_text === 'string') return payload.output_text.trim();
  if (!Array.isArray(payload.output)) return '';
  return payload.output.flatMap((item) =>
    isRecord(item) && Array.isArray(item.content) ? item.content : [],
  ).flatMap((part) =>
    isRecord(part) && part.type === 'output_text' && typeof part.text === 'string' ? [part.text] : [],
  ).join('\n').trim();
}

export async function requestOpenAIExploreAnswer(input: ExploreRequest, options: {
  apiKey: string; model?: string; fetchImpl?: typeof fetch; timeoutMs?: number; signal?: AbortSignal; instructions?: string;
}): Promise<OpenAIExploreResult> {
  const model = options.model?.trim() || DEFAULT_OPENAI_RESPONSE_MODEL;
  return requestUpstream('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, instructions: options.instructions ?? EXPLORE_SYSTEM_INSTRUCTIONS, input: buildExploreInput(input),
      store: false, reasoning: { effort: 'low' }, text: { verbosity: 'low' },
      // Includes reasoning tokens; the prompt still asks for a short spoken answer.
      max_output_tokens: 1200,
    }),
  }, { fetch: options.fetchImpl, signal: options.signal, timeoutMs: options.timeoutMs ?? SERVER_BUDGETS.answer },
  async (response, signal) => {
    const payload = await readUpstreamJson(response, 1024 * 1024, signal);
    if (!isRecord(payload)) throw new UpstreamError('invalid');
    const answer = extractAnswer(payload);
    if (!answer) throw new UpstreamError('empty');
    return { answer, model: typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : model };
  });
}
