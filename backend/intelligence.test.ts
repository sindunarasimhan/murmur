import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { backendConfig } from './config';
import { createIntelligence, playbackAction } from './intelligence';
import type { askChoices, ChoiceAnswer, ChoiceQuestion } from '../src/server/typesafe/client';
import type { ListeningSession } from '../shared/listening';

const session: ListeningSession = { id: randomUUID(), episodeId: 'lenny-brian-halligan', audioVersion: 'a'.repeat(64), revision: 0, positionSeconds: 2250, bookmarkSeconds: 2250, phase: 'listening', pendingAction: null };
test('semantic restart seeks to zero rather than the conversation bookmark', async () => {
  const config = backendConfig(); config.providers.typesafe.apiKey = 'test-only';
  const choices: typeof askChoices = async <K extends string>(_state: unknown, questions: Record<K, ChoiceQuestion>) => {
    assert('restart' in questions['action' as K].criteria);
    return Object.fromEntries(Object.entries<ChoiceQuestion>(questions).map(([key, question]) => {
      const selected = key === 'action' ? 'restart' : key === 'passage' ? 'none' : 'unspecified';
      return [key, { choice: selected, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map((option) => [option, option === selected ? 1 : 0])) }];
    })) as Record<K, ChoiceAnswer>;
  };
  const decision = await createIntelligence(config, choices).decide({ utterance: 'Play it from the very beginning', session, evidence: [], history: [] }, new AbortController().signal);
  assert.deepEqual(decision, { kind: 'seek', position: 0, source: 'jev' });
  const action = playbackAction(decision, session, 4477)!;
  assert.equal(action.positionSeconds, 0); assert.equal(action.play, true); assert.equal(action.kind, 'seek');
  assert.equal(playbackAction({ kind: 'play', source: 'code' }, session, 4477)?.positionSeconds, 2250);
});
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
test('continue inside a conversation reaches semantic interpretation instead of unconditional playback', async () => {
  const config = backendConfig(); config.providers.typesafe.apiKey = 'test-only';
  let calls = 0;
  const choices: typeof askChoices = async <K extends string>(_state: unknown, questions: Record<K, ChoiceQuestion>) => {
    calls++;
    return Object.fromEntries(Object.entries<ChoiceQuestion>(questions).map(([key, question]) => {
      const selected = key === 'action' ? 'unclear' : key === 'passage' ? 'none' : 'unspecified';
      return [key, { choice: selected, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map((option) => [option, option === selected ? 1 : 0])) } satisfies ChoiceAnswer];
    })) as Record<K, ChoiceAnswer>;
  };
  const intelligence = createIntelligence(config, choices);
  const history = [{ question: 'Explain the idea', answer: 'There are two important tradeoffs.' }];
  assert.equal((await intelligence.decide({ utterance: 'Continue.', session, evidence: [], history }, new AbortController().signal)).kind, 'unclear');
  assert.equal(calls, 1);
  assert.equal((await intelligence.decide({ utterance: 'Continue the podcast', session, evidence: [], history }, new AbortController().signal)).kind, 'play');
  assert.equal(calls, 1);
});
