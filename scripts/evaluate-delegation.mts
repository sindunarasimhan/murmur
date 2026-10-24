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
assert(!episodes.some(e => /\ball[ -]in\b/i.test(e.showTitle)), 'All In fixture must be absent from the actual catalog');
console.log(JSON.stringify({ catalogEntries: episodes.length, allInShowPresent: false }));
let decisions: unknown[] = [];
const interpreter = createCatalogInterpreter(config.providers.typesafe, async (...args) => {
  const result = await askChoices(...args); decisions.push(result); return result;
}, createCatalogFallback(config.providers.openai));
let turns = 0;
function conversation(name: string) {
  const history: string[] = [];
  let plan: CatalogFallbackPlan | undefined;
  const service = new CatalogService({ catalog: async () => episodes, unfinished: async () => undefined, charge: async () => {} }, async (...args) => {
    const result = await interpreter(...args); plan = result.kind === 'clarify' ? result.fallback : undefined; return result;
  });
  return async (utterance: string, expected: 'clarify' | 'play' = 'clarify') => {
    decisions = [];
    const result = await service.resolve(name, utterance, undefined, history.slice(-4), AbortSignal.timeout(40_000));
    console.log(JSON.stringify({ scenario: name, utterance, kind: result.kind, reply: result.message, episodeId: result.episode?.id,
      responseKind: plan?.responseKind, questions: plan?.discovery?.discoveryQuestions, limit: plan?.discovery?.questionLimit, pending: plan?.candidateIds, rejected: plan?.discovery?.rejectedEpisodeIds }));
    if (result.kind !== expected || plan?.failure) console.log(JSON.stringify({ decisions, failure: plan?.failure }));
    assert.equal(result.kind, expected); assert.equal(plan?.failure, undefined);
    if (expected === 'play') { assert(episodes.some(e => e.id === result.episode?.id)); assert(!result.message.includes('?')); }
    history.push(utterance, result.message); turns++;
    return { result, plan };
  };
}
const absent = conversation('missing All In');
let step = await absent('Hey Murmur, play All In podcast');
assert.equal(step.plan?.responseKind, 'question'); assert.equal(step.plan?.discovery?.questionLimit, 1);
step = await absent('I am interested in teams building AI products.');
assert.equal(step.plan?.candidateIds.length, 1);
const offered = step.plan!.candidateIds[0];
assert.equal((await absent('Yes, play it', 'play')).result.episode?.id, offered);
if (process.env.MURMUR_ONLY_ALL_IN === '1') process.exit(0);
for (const words of ['Play something random', 'You make a choice', 'Surprise me with something to listen to']) await conversation(words)(words, 'play');
const pending = conversation('delegation after two offers');
step = await pending('Give me two episodes about building AI products.');
assert.equal(step.plan?.candidateIds.length, 2);
const offeredIds = step.plan!.candidateIds;
step = await pending('Explain the difference, but do not play yet.');
assert.equal(step.plan?.responseKind, 'answer');
assert(offeredIds.includes((await pending('You make the choice', 'play')).result.episode!.id));
const corrected = conversation('delegation after rejection and correction');
step = await corrected('Give me one episode about leadership.');
const rejected = step.plan!.candidateIds[0];
step = await corrected('Leave that one aside. I want something about teams making AI products.');
assert(!step.plan?.candidateIds.includes(rejected));
const correctedIds = step.plan!.candidateIds;
assert(correctedIds.includes((await corrected('Pick whichever you think fits best and put it on', 'play')).result.episode!.id));
const constrained = conversation('delegated no match');
step = await constrained('I only want an episode entirely in Icelandic about medieval poetry.');
step = await constrained('You choose what to play within those requirements.');
assert.equal(step.plan?.responseKind, 'no_match');
await conversation('negative delegation')('Do not choose or play for me. Help me decide what I want.');
await conversation('ordinary unsure')('I do not know what to listen to. Help me choose.');
console.log(JSON.stringify({ passed: true, turns, catalogEntries: episodes.length, scope: 'Live text decisions and real catalog; no phone microphone or playback' }));
