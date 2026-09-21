import { isRecord, readUpstreamJson, requestUpstream, UpstreamError } from '../http/upstream';

export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> };
export type ChoiceAnswer = { choice: string; confidence: number; probabilities: Record<string, number> };

function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Validate the distribution as well as the label before any application decision. */
export function parseChoiceAnswer(value: unknown, question: ChoiceQuestion): ChoiceAnswer {
  if (!isRecord(value) || value.type !== 'choice' || typeof value.choice !== 'string' ||
      !Object.hasOwn(question.criteria, value.choice) || !probability(value.confidence) ||
      !isRecord(value.probabilities)) throw new UpstreamError('invalid');
  const options = Object.keys(question.criteria);
  const distribution = value.probabilities;
  if (Object.keys(distribution).length !== options.length) throw new UpstreamError('invalid');
  const probabilities: Record<string, number> = {};
  for (const option of options) {
    const score = distribution[option];
    if (!Object.hasOwn(distribution, option) || !probability(score)) throw new UpstreamError('invalid');
    probabilities[option] = score;
  }
  const scores = Object.values(probabilities);
  if (Math.abs(scores.reduce((total, score) => total + score, 0) - 1) > 0.01 ||
      probabilities[value.choice]! < Math.max(...scores)) throw new UpstreamError('invalid');
  return { choice: value.choice, confidence: value.confidence, probabilities };
}

export async function askChoices<K extends string>(state: unknown, questions: Record<K, ChoiceQuestion>, options: {
  apiKey: string; model: string; timeoutMs: number; signal?: AbortSignal; fetch?: typeof fetch;
}): Promise<Record<K, ChoiceAnswer>> {
  return requestUpstream('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: options.model, state, questions }),
  }, options, async (response, signal) => {
    const payload = await readUpstreamJson(response, 64 * 1024, signal);
    if (!isRecord(payload) || !isRecord(payload.answers)) throw new UpstreamError('invalid');
    const answers = {} as Record<K, ChoiceAnswer>;
    for (const key of Object.keys(questions) as K[]) answers[key] = parseChoiceAnswer(payload.answers[key], questions[key]);
    return answers;
  });
}
