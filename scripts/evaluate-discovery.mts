// Live text-only evaluation against stored catalog metadata. No listening
// sessions, playback, microphone capture, or database mutations are performed.
import assert from 'node:assert/strict';
import { backendConfig } from '../backend/config';
import { createDatabase } from '../backend/database';
import { Repository } from '../backend/repository';
import { createCatalogFallback, type CatalogFallbackPlan } from '../backend/catalog-fallback';
import { createCatalogInterpreter } from '../backend/catalog-interpreter';
import { CatalogService } from '../backend/catalog-service';

const config = backendConfig();
const pool = createDatabase(config.databaseUrl);
const episodes = await new Repository(pool, config).catalog().finally(() => pool.end());
assert(episodes.length > 0, 'Load a real catalog before evaluating discovery');
const plans: CatalogFallbackPlan[] = [];
const compose = createCatalogFallback(config.providers.openai);
const service = new CatalogService({ catalog: async () => episodes, unfinished: async () => undefined, charge: async () => {} },
  createCatalogInterpreter(config.providers.typesafe, undefined, async (...args) => {
    const plan = await compose(...args); plans.push(plan); return plan;
  }));
const transcript: unknown[] = [];
let history: string[] = [];
const turn = async (utterance: string) => {
  const result = await service.resolve('discovery-eval', utterance, undefined, history.slice(-4), AbortSignal.timeout(30_000));
  const plan = plans.at(-1);
  const entry = { utterance, reply: result.message, kind: result.kind, offeredIds: plan?.candidateIds, memory: plan?.discovery, failure: plan?.failure };
  transcript.push(entry); console.log(JSON.stringify(entry));
  assert.equal(result.kind, 'clarify', 'Discovery must not auto-play');
  assert(!result.message.includes('trouble thinking'), `Live composer did not return a validated reply: ${plan?.failure ?? 'unknown'}`);
  assert((result.message.match(/\?/g) ?? []).length <= 1);
  history.push(utterance, result.message);
  return plan!;
};
await turn('Play a Lex Fridman interview');
assert.deepEqual(plans.at(-1)!.candidateIds, [], 'An unavailable request alone must not produce a menu');
await turn('I do not know what I am looking for. Can you help me figure it out?');
assert.deepEqual(plans.at(-1)!.candidateIds, [], 'Broad uncertainty needs useful direction, not immediate titles');
await turn('I have been thinking about how people work together when technology changes so fast.');
await turn('Not sales or growing a business. I care about the people doing the work.');
await turn('I would like a concrete interview about that now. What do you have?');
const offered = [...plans.at(-1)!.candidateIds];
assert(offered.length > 0, 'Concrete request should produce a catalog-backed option');
await turn('Before picking, why does that fit what I told you?');
const changed = await turn('Leave those options aside. I am more curious about actually building AI products.');
assert(!changed.candidateIds.some((id) => offered.includes(id)), 'A rejected offer must not reappear on the next turn');
const finalPlan = await turn('Show me a different interview about a product team making AI tools.');
assert(finalPlan.candidateIds.length > 0);
assert(!finalPlan.candidateIds.some((id) => offered.includes(id)), 'Rejected options must not be recycled');
const selected = await service.resolve('discovery-eval', 'Play the first one', undefined, history.slice(-4), AbortSignal.timeout(30_000));
assert.equal(selected.kind, 'play');
assert.equal(selected.episode?.id, finalPlan.candidateIds[0]);
console.log(JSON.stringify({ selection: selected.episode?.id, catalogEntries: episodes.length, turns: transcript.length + 1, scope: 'Live text models and catalog metadata; no audio or sessions' }));
