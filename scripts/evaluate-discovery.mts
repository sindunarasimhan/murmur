// Live text-only acceptance against the real catalog. No database writes,
// listening sessions or audio. Measures questions and turns to a real offer.
import assert from 'node:assert/strict';
import { backendConfig } from '../backend/config';
import { createDatabase } from '../backend/database';
import { Repository } from '../backend/repository';
import { createCatalogFallback, type CatalogFallbackPlan } from '../backend/catalog-fallback';
import { createCatalogInterpreter } from '../backend/catalog-interpreter';
import { CatalogService } from '../backend/catalog-service';
import { askChoices } from '../src/server/typesafe/client';

const config = backendConfig();
const pool = createDatabase(config.databaseUrl);
const episodes = await new Repository(pool, config).catalog().finally(() => pool.end());
assert(episodes.length > 0);
const decisions: unknown[] = [];
const interpreter = createCatalogInterpreter(config.providers.typesafe, async (state, questions, options) => {
  const answers = await askChoices(state, questions, options);
  decisions.push(answers);
  return answers;
}, createCatalogFallback(config.providers.openai));
let totalTurns = 0;
function dialogue(name: string) {
  const history: string[] = [];
  let plan: CatalogFallbackPlan | undefined;
  const service = new CatalogService({ catalog: async () => episodes, unfinished: async () => undefined, charge: async () => {} }, async (...args) => {
    const intent = await interpreter(...args);
    if (intent.kind === 'clarify') plan = intent.fallback;
    return intent;
  });
  return async (utterance: string, expected: 'clarify' | 'play' = 'clarify') => {
    plan = undefined; decisions.length = 0;
    const result = await service.resolve(name, utterance, undefined, history.slice(-4), AbortSignal.timeout(40_000));
    totalTurns++;
    console.log(JSON.stringify({ scenario: name, utterance, reply: result.message, kind: result.kind, episodeId: result.episode?.id, responseKind: plan?.responseKind, questions: plan?.discovery?.discoveryQuestions, limit: plan?.discovery?.questionLimit, pending: plan?.discovery?.pendingOffers, failure: plan?.failure }));
    if (result.kind !== expected || plan?.failure) console.log(JSON.stringify({ decisions }));
    assert.equal(result.kind, expected, `${name}: ${utterance}`);
    assert.equal(plan?.failure, undefined, `${name}: composer failed`);
    assert(!result.message.includes('trouble thinking'), result.message);
    if (plan) {
      assert((result.message.match(/\?/g) ?? []).length <= 1);
      assert((plan.discovery?.discoveryQuestions ?? 0) <= (plan.discovery?.questionLimit ?? 2));
      assert(result.message.split(/\s+/).length <= 90);
      for (const item of plan.discovery?.pendingOffers ?? []) {
        assert(episodes.some((episode) => episode.id === item.episodeId));
        assert((item.label?.length ?? 0) < 110);
      }
    }
    history.push(utterance, result.message);
    return { result, plan };
  };
}

const fast = dialogue('direct request');
const target = episodes.find((episode) => episode.id === 'lenny-cat-wu') ?? episodes[0]!;
assert.equal((await fast(`Play ${target.title}`, 'play')).result.episode?.id, target.id);

const open = dialogue('uncertain listener');
let step = await open('I have no idea what I feel like listening to. Help me choose.');
assert.equal(step.plan!.responseKind, 'question', 'A cold uncertain listener needs one useful direction question first');
assert.equal(step.plan!.discovery?.discoveryQuestions, 1);
for (let count = 1; !(step.plan?.candidateIds.length); count++) {
  assert(count < 3, 'Open discovery must offer by response three');
  step = await open(count === 1 ? 'I am still not sure what topic I want.' : 'I cannot narrow it down further.');
}
assert.equal(step.plan!.candidateIds.length, 1, 'Uncertainty should get one easy starting option');
const openId = step.plan!.candidateIds[0];
assert.equal((await open('Yes, please', 'play')).result.episode?.id, openId);

const missing = dialogue('unavailable request');
step = await missing('Play the Uncatalogued Sound Archive podcast');
assert.equal(step.plan!.responseKind, 'question', 'An unknown unavailable show is not enough context for a substitute');
assert.equal(step.plan!.discovery?.discoveryQuestions, 1);
if (!step.plan?.candidateIds.length) step = await missing('I care about how people collaborate when technology changes.');
assert(step.plan!.candidateIds.length > 0, 'Unavailable request must offer by response two');
assert((step.plan!.discovery?.discoveryQuestions ?? 0) <= 1);
const previous = step.plan!.candidateIds;
step = await missing('Leave those options aside. I am interested in actually building AI tools now.');
assert(step.plan!.candidateIds.length > 0, 'Correction should refine the offer without another interview');
assert(!step.plan!.candidateIds.some((id) => previous.includes(id)), 'Do not recycle rejected options');
step = await missing('Do not play yet. Explain why that fits.');
assert.equal(step.plan!.responseKind, 'answer');
assert(!step.result.message.includes('?'), 'An explanation must not repeat a play-consent question');
step = await missing('Give me one option about a team building AI products.');
assert.equal(step.plan!.candidateIds.length, 1);
const correctedId = step.plan!.candidateIds[0];
step = await missing('Not yet. I want to wait before listening.');
assert.equal(step.plan!.responseKind, 'hold');
assert(!step.result.message.includes('?'));
assert.equal(step.plan!.discovery?.discoveryQuestions, 1);
assert.equal(step.plan!.discovery?.pendingOffers[0]?.episodeId, correctedId);
assert.equal((await missing('Play that one', 'play')).result.episode?.id, correctedId);

const two = dialogue('two-option consent');
step = await two('Give me two different episodes about building AI products to choose between.');
assert.equal(step.plan!.candidateIds.length, 2);
const secondId = step.plan!.candidateIds[1];
step = await two('Yes');
assert.equal(step.plan!.responseKind, 'selection');
assert.equal(step.plan!.candidateIds[1], secondId);
assert.equal((await two('The second one', 'play')).result.episode?.id, secondId);

const noFit = dialogue('unsupported constraints');
step = await noFit('I only want an episode entirely in Icelandic about medieval Icelandic poetry. Do not suggest another topic or language.');
assert.equal(step.plan!.responseKind, 'no_match');
assert.equal(step.plan!.candidateIds.length, 0);

console.log(JSON.stringify({ passed: true, catalogEntries: episodes.length, totalTurns, scenarios: 5, scope: 'Live text models and real catalog metadata; no audio or sessions' }));
