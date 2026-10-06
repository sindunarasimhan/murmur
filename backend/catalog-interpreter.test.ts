import assert from 'node:assert/strict';
import test from 'node:test';
import { backendConfig } from './config';
import { createCatalogInterpreter } from './catalog-interpreter';
import { createDatabase } from './database';
import { Repository } from './repository';
import { askChoices, type ChoiceAnswer, type ChoiceQuestion } from '../src/server/typesafe/client';

test('live catalog understands spoken guest spellings without substituting unavailable shows', { skip: process.env.MURMUR_LIVE_SEMANTICS !== '1' }, async () => {
  const config = backendConfig();
  const pool = createDatabase(config.databaseUrl);
  const episodes = await new Repository(pool, config).catalog().finally(() => pool.end());
  const interpret = createCatalogInterpreter(config.providers.typesafe);
  for (const [utterance, guest] of [
    ['Play the Cat Woo podcast', 'Cat Wu'],
    ['Put on the Boris Cherney interview', 'Boris Cherny'],
    ['I want the Claire Voe episode', 'Claire Vo'],
    ['Play the Lex Fridman podcast', undefined],
    ['Play Planet Money instead', undefined],
  ] as const) {
    const result = await interpret({ utterance, history: [], episodes }, new AbortController().signal);
    if (guest) {
      assert.equal(result.kind, 'select', utterance);
      assert.equal(result.kind === 'select' && episodes.find((episode) => episode.id === result.episodeId)?.guest, guest, utterance);
    } else assert.equal(result.kind, 'clarify', utterance);
  }
});

test('current-episode routing combines probability only for equivalent current and resume destinations', async () => {
  const config = backendConfig(); config.providers.typesafe.apiKey = 'test-only';
  const choices = async <K extends string>(_state: unknown, questions: Record<K, ChoiceQuestion>): Promise<Record<K, ChoiceAnswer>> => {
    const answers = {} as Record<K, ChoiceAnswer>;
    for (const key of Object.keys(questions) as K[]) {
      const question = questions[key];
      const choice = key === 'action' ? 'resume' : Object.keys(question.criteria)[0]!;
      const probabilities = Object.fromEntries(Object.keys(question.criteria).map((option) => [option,
        key === 'action' ? ({ resume: 0.73, current: 0.11, unclear: 0.15, choose: 0.01 } as Record<string, number>)[option] ?? 0 : Number(option === choice)]));
      answers[key] = { choice, confidence: 0.68, probabilities };
    }
    return answers;
  };
  const interpret = createCatalogInterpreter(config.providers.typesafe, choices);
  const context = { utterance: 'Pick up from there', history: [], episodes: [{ id: 'brian', title: 'Brian', showTitle: 'Lenny', guest: 'Brian', description: '' }] };
  assert.equal((await interpret({ ...context, currentEpisodeId: 'brian' }, new AbortController().signal)).kind, 'resume');
  assert.equal((await interpret(context, new AbortController().signal)).kind, 'clarify');
});

test('live catalog routing separates returning to playback from continuing a discussion', { skip: process.env.MURMUR_LIVE_SEMANTICS !== '1' }, async () => {
  const config = backendConfig();
  const pool = createDatabase(config.databaseUrl);
  const catalog = await new Repository(pool, config).catalog().finally(() => pool.end());
  const episodes = catalog.map(({ id, title, showTitle, guest, description }) => ({ id, title, showTitle, guest, description }));
  const currentEpisodeId = episodes.find((episode) => episode.guest === 'Brian Halligan')!.id;
  const history = [
    'what does he mean by that?',
    'He means a good CEO is never fully satisfied with the current state, even when things are going well. It’s not complaining; it’s staying slightly uncomfortable so you keep pushing toward the bigger goal. The nuance is that the dissatisfaction is constructive, so it drives progress without turning into pessimism.',
    'Could you give me a concrete example?',
    'Hypothetical: a company just hit its quarterly target, but the CEO still says, “Good—now how do we cut onboarding time in half and make the product stickier?” That’s the tension: celebrating the win without settling into it. The useful implication is to treat success as a checkpoint, not a finish line.',
  ];
  let action: unknown;
  const interpret = createCatalogInterpreter(config.providers.typesafe, async (state, questions, options) => {
    const answers = await askChoices(state, questions, options);
    action = Object.entries(answers).find(([key]) => key === 'action')?.[1];
    return answers;
  });
  const cases = [
    ['Take me back to the podcast now', 'resume'],
    ['Let’s hear the rest of the episode', 'resume'],
    ['Enough explanation, carry on with the recording', 'resume'],
    ['Could you continue explaining that example?', 'current'],
    ['Tell me more about the podcast guest’s point', 'current'],
    ['Take me back to the home screen', 'home'],
    ['End this episode', 'home'],
    ['Play this episode from the beginning', 'current'],
    ['Play the Benedict Evans episode instead', 'select'],
  ] as const;
  for (let round = 0; round < Number(process.env.MURMUR_LIVE_SEMANTIC_ROUNDS ?? 1); round++) {
    for (const [utterance, expected] of cases) {
      const result = await interpret({ utterance, currentEpisodeId, history, episodes }, new AbortController().signal);
      assert.equal(result.kind, expected, `${utterance}: ${JSON.stringify(action)}`);
    }
  }
});

test('live catalog routing separates ending an episode from disabling voice', { skip: process.env.MURMUR_LIVE_SEMANTICS !== '1' }, async () => {
  const interpret = createCatalogInterpreter(backendConfig().providers.typesafe);
  const episodes = [{ id: 'brian', title: 'Brian Halligan', showTitle: 'Lenny’s Podcast', guest: 'Brian Halligan', description: 'HubSpot' }];
  for (const [utterance, expected] of [
    ['End the stream', 'home'],
    ['Stop this episode and take me home', 'home'],
    ['I am done with this podcast', 'home'],
    ['Turn off the microphone', 'stop'],
    ['Stop listening to me', 'stop'],
    ['Pause the podcast', 'current'],
    ['Could you get the podcast going again', 'resume'],
    ['Never mind', 'cancel'],
    ['Forget what I asked', 'cancel'],
  ] as const) {
    const result = await interpret({ utterance, currentEpisodeId: 'brian', history: [], episodes }, new AbortController().signal);
    assert.equal(result.kind, expected, utterance);
  }
});
