import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { backendConfig } from './config';
import { createIntelligence } from './intelligence';
import type { askChoices, ChoiceAnswer, ChoiceQuestion } from '../src/server/typesafe/client';
import type { ListeningSession } from '../shared/listening';

const session: ListeningSession = { id: randomUUID(), episodeId: 'lenny-brian-halligan', audioVersion: 'a'.repeat(64), revision: 0, positionSeconds: 2250, bookmarkSeconds: 2250, phase: 'listening', pendingAction: null };
test('a confident skip action still needs an explicit, confident advertising target', async () => {
  const config = backendConfig(); config.providers.typesafe.apiKey = 'test-only';
  for (const probability of [0, 0.74, 0.9, 1]) {
    const choices: typeof askChoices = async <K extends string>(_state: unknown, questions: Record<K, ChoiceQuestion>) => Object.fromEntries(Object.entries<ChoiceQuestion>(questions).map(([key, question]) => {
      const selected = key === 'action' ? 'skip-ad' : key === 'passage' ? 'none' : probability >= 0.5 ? 'advertisement' : 'unspecified';
      return [key, { choice: selected, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map((option) => [option, key === 'skipTarget' ? option === 'advertisement' ? probability : option === 'unspecified' ? 1 - probability : 0 : option === selected ? 1 : 0])) } satisfies ChoiceAnswer];
    })) as Record<K, ChoiceAnswer>;
    const result = await createIntelligence(config, choices).decide({ utterance: 'A semantic skip request', session, evidence: [], history: [] }, new AbortController().signal);
    assert.equal(result.kind, probability >= 0.85 ? 'skip-ad' : 'unclear');
  }
});
test('exact playback commands remain available without an AI decision', async () => {
  const choices: typeof askChoices = async () => { throw new Error('The provider must not run'); };
  const decision = await createIntelligence(backendConfig(), choices).decide({ utterance: 'go to thirty-seven minutes', session, evidence: [], history: [] }, new AbortController().signal);
  assert.equal(decision.position, 2220); assert.equal(decision.source, 'code');
});
