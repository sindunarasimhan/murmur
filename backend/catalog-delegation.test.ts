import assert from 'node:assert/strict';
import test from 'node:test';
import { delegatedCatalogSelection } from './catalog-delegation';
import { createCatalogInterpreter, type CatalogContext } from './catalog-interpreter';
import { emptyDiscovery } from './catalog-discovery';
import { type askChoices, type ChoiceAnswer } from '../src/server/typesafe/client';

const provider = { apiKey: 'test', model: 'test' };
const answer = (choice: string, score = 1): ChoiceAnswer => ({ choice, confidence: score, probabilities: { [choice]: score } });
const context: CatalogContext = { utterance: 'Choose what to play for me', history: [], episodes: [
  { id: 'ai', title: 'Building AI tools', showTitle: 'Build', guest: 'A Person', description: 'Product teams building AI products.' },
  { id: 'space', title: 'Exploring planets', showTitle: 'Orbit', guest: 'B Person', description: 'Exploration of planets.' },
] };
const choices = (scope = 'fresh', episode = 'ai', permission = 'play', score = 1): typeof askChoices =>
  async <K extends string>() => ({ action: answer('delegate'), initialAction: answer('none'), delegation: answer(permission, score), scope: answer(scope), episode: answer(episode), compatible: answer('yes') }) as Record<K, ChoiceAnswer>;
const signal = () => new AbortController().signal;

test('fresh explicit delegation selects an eligible ID through the common route', async () => {
  const result = await createCatalogInterpreter(provider, choices())(context, signal());
  assert.equal(result.kind, 'select');
  assert(result.kind === 'select' && context.episodes.some(({ id }) => id === result.episodeId));
  assert(result.kind === 'select' && result.delegated);
});

test('contextual delegation respects the pending set and rejected IDs', async () => {
  const discovery = { ...emptyDiscovery(), preferences: [{ value: 'AI products', basis: 'explicit' as const }], pendingOffers: [{ option: 1, episodeId: 'ai' }], rejectedEpisodeIds: ['space'] };
  const scoped = { ...context, discovery, currentEpisodeId: 'space' };
  assert.deepEqual(await delegatedCatalogSelection(scoped, provider, choices('pending'), signal()), { kind: 'select', episodeId: 'ai', delegated: true });
  for (const id of ['space', 'invented', 'none']) {
    assert.equal((await delegatedCatalogSelection(scoped, provider, choices('pending', id), signal()))?.kind, 'clarify');
  }
  assert.equal((await delegatedCatalogSelection({ ...context, discovery: { ...discovery, rejectedEpisodeIds: [] } }, provider, choices('pending', 'space'), signal()))?.kind, 'clarify');
});

test('ordinary uncertainty or weak delegation confidence never authorizes this route', async () => {
  for (const [permission, score] of [['explore', 1], ['play', 0.65]] as const) {
    assert.equal(await delegatedCatalogSelection(context, provider, choices('fresh', 'ai', permission, score), signal()), undefined);
  }
});

test('contextual no match cannot silently become a global random pick or reset discovery', async () => {
  const discovery = { ...emptyDiscovery(), intent: 'Only Icelandic poetry', discoveryQuestions: 1, questionLimit: 1 as const };
  const result = await delegatedCatalogSelection({ ...context, discovery }, provider, choices('contextual', 'none'), signal());
  assert.equal(result?.kind, 'clarify');
  assert(result?.kind === 'clarify' && result.fallback?.responseKind === 'no_match');
  assert.deepEqual(result?.kind === 'clarify' && result.fallback?.discovery, discovery);
});

test('cancelled delegated selection never returns a playable result', async () => {
  const controller = new AbortController();
  const pending: typeof askChoices = async (...args) => { controller.abort(); return choices()(...args); };
  await assert.rejects(delegatedCatalogSelection(context, provider, pending, controller.signal), { name: 'AbortError' });
});
