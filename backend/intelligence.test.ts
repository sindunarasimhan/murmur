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
test('playback commands require the semantic intent layer instead of phrase shortcuts', async () => {
  const choices: typeof askChoices = async () => { throw new Error('The provider must not run without configuration'); };
  await assert.rejects(
    createIntelligence(backendConfig(), choices).decide({ utterance: 'go to thirty-seven minutes', session, evidence: [], history: [] }, new AbortController().signal),
    { code: 'decision_unavailable' },
  );
});
test('continue inside a conversation reaches semantic interpretation instead of unconditional playback', async () => {
  const config = backendConfig(); config.providers.typesafe.apiKey = 'test-only';
  let calls = 0;
  const choices: typeof askChoices = async <K extends string>(state: unknown, questions: Record<K, ChoiceQuestion>) => {
    calls++;
    return Object.fromEntries(Object.entries<ChoiceQuestion>(questions).map(([key, question]) => {
      const selected = key === 'action'
        ? (state as { utterance: string }).utterance.includes('podcast') ? 'play' : 'unclear'
        : key === 'passage' ? 'none' : 'unspecified';
      return [key, { choice: selected, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map((option) => [option, option === selected ? 1 : 0])) } satisfies ChoiceAnswer];
    })) as Record<K, ChoiceAnswer>;
  };
  const intelligence = createIntelligence(config, choices);
  const history = [{ question: 'Explain the idea', answer: 'There are two important tradeoffs.' }];
  assert.equal((await intelligence.decide({ utterance: 'Continue.', session, evidence: [], history }, new AbortController().signal)).kind, 'unclear');
  assert.equal(calls, 1);
  assert.equal((await intelligence.decide({ utterance: 'Continue the podcast', session, evidence: [], history }, new AbortController().signal)).kind, 'play');
  assert.equal(calls, 2);
});

test('semantic playback has one resume outcome rather than competing play and return labels', async () => {
  const config = backendConfig(); config.providers.typesafe.apiKey = 'test-only';
  const choices: typeof askChoices = async <K extends string>(_state: unknown, questions: Record<K, ChoiceQuestion>) => {
    assert('return' in questions['action' as K].criteria);
    return Object.fromEntries(Object.entries<ChoiceQuestion>(questions).map(([key, question]) => {
      const selected = key === 'action' ? 'play' : key === 'passage' ? 'none' : 'unspecified';
      return [key, { choice: selected, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map((option) => [option, option === selected ? 1 : 0])) }];
    })) as Record<K, ChoiceAnswer>;
  };
  const decision = await createIntelligence(config, choices).decide({ utterance: 'Pick up where we left off', session, evidence: [], history: [] }, new AbortController().signal);
  assert.equal(decision.kind, 'play');
  assert.equal(decision.source, 'jev');
  assert.equal(playbackAction(decision, session, 4477)?.positionSeconds, session.bookmarkSeconds);
});

test('semantic closure returns to the bookmarked podcast while follow-up questions continue exploring', async () => {
  const config = backendConfig(); config.providers.typesafe.apiKey = 'test-only';
  for (const [utterance, selected, expected] of [
    ['Okay, I am done with this side discussion', 'return', 'return'],
    ['Got it, but why?', 'deeper', 'deeper'],
  ] as const) {
    const choices: typeof askChoices = async <K extends string>(_state: unknown, questions: Record<K, ChoiceQuestion>) => Object.fromEntries(Object.entries<ChoiceQuestion>(questions).map(([key, question]) => {
      const choice = key === 'action' ? selected : key === 'passage' ? 'none' : 'unspecified';
      return [key, { choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map((option) => [option, option === choice ? 1 : 0])) } satisfies ChoiceAnswer];
    })) as Record<K, ChoiceAnswer>;
    const decision = await createIntelligence(config, choices).decide({
      utterance, session, evidence: [], history: [{ question: 'Explain that', answer: 'It means revealing complexity gradually.' }],
    }, new AbortController().signal);
    assert.equal(decision.kind, expected, utterance);
    if (decision.kind === 'return') {
      const action = playbackAction(decision, session, 4477)!;
      assert.equal(action.kind, 'return');
      assert.equal(action.positionSeconds, session.bookmarkSeconds);
      assert.equal(action.play, true);
    }
  }
});

test('exploration does not close on lightweight acknowledgement when history can support more depth', async () => {
  const config = backendConfig(); config.providers.typesafe.apiKey = 'test-only';
  const choices: typeof askChoices = async <K extends string>(_state: unknown, questions: Record<K, ChoiceQuestion>) => {
    assert.match(questions['action' as K].instructions, /keep the side discussion open by default/i);
    assert.match(questions['action' as K].criteria.return!, /not a lightweight acknowledgement/i);
    return Object.fromEntries(Object.entries<ChoiceQuestion>(questions).map(([key, question]) => {
      const selected = key === 'action' ? 'deeper' : key === 'passage' ? 'p1' : 'unspecified';
      return [key, { choice: selected, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map((option) => [option, option === selected ? 1 : 0])) } satisfies ChoiceAnswer];
    })) as Record<K, ChoiceAnswer>;
  };
  const decision = await createIntelligence(config, choices).decide({
    utterance: 'Okay, but why?',
    session,
    evidence: [{ id: 'p1', startSeconds: 10, endSeconds: 20, text: 'Product taste improves through repeated judgment and feedback.' }],
    history: [{ question: 'What is product taste?', answer: 'Product taste is judgment about what is worth building and why.' }],
  }, new AbortController().signal);
  assert.equal(decision.kind, 'deeper');
});

test('follow-up exploration carries conversation context without phrase-specific routing', async () => {
  const config = backendConfig(); config.providers.typesafe.apiKey = 'test-only';
  let observed: unknown;
  const choices: typeof askChoices = async <K extends string>(state: unknown, questions: Record<K, ChoiceQuestion>) => {
    observed = state;
    assert.match(questions['action' as K].instructions, /latest established discussion topic/i);
    assert.match(questions['action' as K].criteria.deeper!, /history or memory supplies the topic/i);
    assert.doesNotMatch(questions['action' as K].instructions, /how do you develop that/i);
    assert.doesNotMatch(questions['action' as K].criteria.deeper!, /how to develop that/i);
    return Object.fromEntries(Object.entries<ChoiceQuestion>(questions).map(([key, question]) => {
      const selected = key === 'action' ? 'deeper' : key === 'passage' ? 'p1' : 'unspecified';
      return [key, { choice: selected, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map((option) => [option, option === selected ? 1 : 0])) } satisfies ChoiceAnswer];
    })) as Record<K, ChoiceAnswer>;
  };
  for (const utterance of ['How would someone improve it?', 'Can you give me an example?', 'Why does that matter?']) {
    const decision = await createIntelligence(config, choices).decide({
      utterance,
      session,
      evidence: [{ id: 'p1', startSeconds: 10, endSeconds: 20, text: 'Product taste is the judgment for what to build and how it should feel.' }],
      history: [{ question: 'What is product taste?', answer: 'Product taste is judgment about what is worth building and why.' }],
    }, new AbortController().signal);
    assert.equal(decision.kind, 'deeper', utterance);
    assert.equal(decision.passageId, 'p1', utterance);
    assert.deepEqual((observed as { history: unknown[] }).history, [{ question: 'What is product taste?', answer: 'Product taste is judgment about what is worth building and why.' }]);
  }
});

test('live semantic commands resolve against the prepared podcast and conversation context', { skip: process.env.MURMUR_LIVE_SEMANTICS !== '1' }, async () => {
  const { Pool } = await import('pg');
  const { Repository } = await import('./repository');
  const config = backendConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const repository = new Repository(pool, config);
    const episode = await repository.episode('lenny-brian-halligan');
    const current: ListeningSession = { ...session, audioVersion: episode.audioVersion, phase: 'resolving', positionSeconds: 270.375, bookmarkSeconds: 270.375 };
    const intelligence = createIntelligence(config);
    const cases = [
      { utterance: 'continue where we left off', expected: 'play' },
      { utterance: 'Pick up from there', expected: 'play' },
      { utterance: 'Could you get the podcast going again', expected: 'play' },
      { utterance: 'Let us get back to the podcast', expected: 'return', explanation: true },
      { utterance: 'Okay, I am done with the side discussion', expected: 'return', explanation: true },
      { utterance: 'Got it, but why?', expected: 'deeper', explanation: true },
      { utterance: 'Could you pause this for a moment', expected: 'pause' },
      { utterance: 'Run it from the top', expected: 'seek' },
      { utterance: 'Can you explain what he meant by that', expected: 'explain' },
      { utterance: 'Tell me more about that tradeoff', expected: 'deeper', explanation: true },
    ];
    for (const item of cases) {
      const evidence = await repository.evidence(current, item.utterance);
      const history = item.explanation ? [{ question: 'Explain that tradeoff', answer: 'The tradeoff is faster growth versus retaining control.' }] : [];
      const decision = await intelligence.decide({ utterance: item.utterance, session: current, evidence, history }, new AbortController().signal);
      assert.equal(decision.kind, item.expected, item.utterance);
      assert.equal(decision.source, 'jev', item.utterance);
      if (decision.kind === 'play') assert.equal(playbackAction(decision, current, episode.durationSeconds)?.positionSeconds, 270.375);
      if (decision.kind === 'seek') assert.equal(decision.position, 0);
    }
  } finally { await pool.end(); }
});
