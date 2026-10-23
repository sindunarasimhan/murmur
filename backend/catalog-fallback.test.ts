import assert from 'node:assert/strict';
import test from 'node:test';
import type { PreparedEpisode } from '../shared/listening';
import { type askChoices, type ChoiceAnswer } from '../src/server/typesafe/client';
import { createCatalogFallback, createDiscoveryComposer, fallbackResolution, recentCatalogOffers, type DiscoveryDraft } from './catalog-fallback';
import { createCatalogInterpreter, type CatalogContext } from './catalog-interpreter';
import { CatalogService } from './catalog-service';
import { CatalogDiscoveryMemory, emptyDiscovery } from './catalog-discovery';
import { backendConfig } from './config';

const episodes: PreparedEpisode[] = [
  { id: 'space', title: 'Navigating deep space', showTitle: 'Orbit Notes', guest: 'Maya Chen', description: 'Navigation and mission planning for planetary exploration.', durationSeconds: 3600, status: 'ready', audioVersion: 'a'.repeat(64), audioPath: '/media/space.mp3', transcriptReady: true },
  { id: 'design', title: 'Accessible public services', showTitle: 'Design Fieldwork', guest: 'Inez Costa', description: 'Inclusive design and research for civic services.', durationSeconds: 1800, status: 'ready', audioVersion: 'b'.repeat(64), audioPath: '/media/design.mp3', transcriptReady: true },
  { id: 'missions', title: 'Life beyond Earth', showTitle: 'Science Notebook', guest: 'Ravi Patel', description: 'Planetary exploration and the search for life.', durationSeconds: 2400, status: 'ready', audioVersion: 'c'.repeat(64), audioPath: '/media/missions.mp3', transcriptReady: true },
];
const provider = { ...backendConfig().providers.openai, apiKey: 'test-only' };
const signal = () => new AbortController().signal;
const context: CatalogContext = { utterance: 'Help me figure it out', history: [], episodes, allowOffers: true };
const answer = (choice: string): ChoiceAnswer => ({ choice, probabilities: { [choice]: 1 }, confidence: 1 });
const repository = () => ({ catalog: async () => episodes, unfinished: async () => undefined, charge: async () => {} });
const memory = () => ({ intent: 'Find something interesting', preferences: [], unknowns: [], rejectedEpisodeIds: [] });
const draft = (overrides: Partial<DiscoveryDraft> = {}): DiscoveryDraft => ({
  reply: 'We could follow the question of whether life exists elsewhere. That gives us a mystery to explore without choosing an episode yet.',
  offerBasis: 'none', offers: [], memory: memory(), ...overrides,
});
const offer = (): DiscoveryDraft => draft({
  reply: '{{1}} follows the search for life beyond our planet, which connects to your curiosity about what we might discover.',
  offerBasis: 'context_ready', offers: [{ episodeId: 'missions', evidenceField: 'description' }],
});

test('natural discovery has no fixed question category, no premature title and no forced play close', async () => {
  const plan = await createCatalogFallback(provider, async () => draft())(context, false, signal());
  assert.equal(plan.message, draft().reply);
  assert.deepEqual(plan.candidateIds, []);
  assert.equal(fallbackResolution(episodes, plan).kind, 'clarify');
  const options = await createCatalogFallback(provider, async () => offer())(context, false, signal());
  assert(options.message.includes(episodes[2]!.title));
  assert(!options.message.includes('?'));
  assert.deepEqual(options.discovery?.pendingOffers, [{ option: 1, episodeId: 'missions' }]);
  const tooSoon = await createCatalogFallback(provider, async () => offer())({ ...context, allowOffers: false }, true, signal());
  assert.equal(tooSoon.failure, 'offers_not_ready');
  assert.deepEqual(tooSoon.candidateIds, []);
  const plainTopic = await createCatalogFallback(provider, async () => draft({ reply: 'We could explore whether there is life beyond Earth.' }))({ ...context, allowOffers: false }, false, signal());
  assert.equal(plainTopic.failure, undefined, 'A subject that overlaps a title is still valid conversational language');
  const named = await createCatalogFallback(provider, async () => offerWithNamedReference())(context, false, signal());
  assert.deepEqual(named.candidateIds, ['missions']);
  assert(named.message.includes(episodes[2]!.title));
});

function offerWithNamedReference(): DiscoveryDraft {
  return { ...offer(), reply: '[[missions]] connects directly to your interest in the search for life.' };
}

test('unknown IDs, unsupported evidence, title bypasses, malformed output and excess questions fail closed', async () => {
  const invalid: unknown[] = [
    { ...offer(), offers: [{ episodeId: 'invented', evidenceField: 'description' }] },
    { ...offer(), offers: [{ episodeId: 'missions', evidenceField: 'humor' }] },
    { ...offer(), reply: 'Try “Life beyond Earth”.' },
    { ...offer(), reply: '{{2}} is relevant.' },
    { ...draft(), reply: 'What topic? What length?' },
    { ...draft(), offers: offer().offers },
    { ...offer(), memory: { ...memory(), rejectedEpisodeIds: ['missions'] } },
    { reply: 'Truncated' },
  ];
  for (const output of invalid) {
    const plan = await createCatalogFallback(provider, async () => output)(context, false, signal());
    assert.deepEqual(plan.candidateIds, []);
    assert.match(plan.message, /trouble/);
    assert.equal(fallbackResolution(episodes, plan).episode, undefined);
  }
});

test('provider failure is honest and cancellation cannot return a late generated reply', async () => {
  const plan = await createCatalogFallback(provider, async () => { throw new Error('offline'); })(context, true, signal());
  assert.match(plan.message, /couldn’t find.*trouble/);
  const controller = new AbortController();
  await assert.rejects(createCatalogFallback(provider, async () => { controller.abort(); return offer(); })(context, false, controller.signal), { name: 'AbortError' });
});

test('a malformed generated draft gets one bounded repair without committing an offer', async () => {
  let calls = 0;
  const plan = await createCatalogFallback(provider, async (input) => {
    calls++;
    if (calls === 1) return draft({ reply: 'Consider {{1}}.' });
    assert.equal((input as { repair: { reason: string } }).repair.reason, 'invalid_option_references');
    return draft();
  })({ ...context, allowOffers: false }, false, signal());
  assert.equal(calls, 2);
  assert.equal(plan.failure, undefined);
  assert.deepEqual(plan.candidateIds, []);
});

test('structured response transport requires a complete response and sends bounded non-stored requests', async () => {
  const fetcher: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    assert.equal(request.store, false);
    assert.equal(request.text.format.type, 'json_schema');
    assert.equal(request.text.format.strict, true);
    assert.equal(request.text.format.schema.additionalProperties, false);
    assert.equal(request.text.format.schema.properties.offers.maxItems, 0, 'Exploration cannot emit a title shortlist');
    assert(request.max_output_tokens <= 2400);
    return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(draft()) }] }] });
  };
  assert.deepEqual(await createDiscoveryComposer(provider, fetcher)({}, signal()), draft());
  for (const payload of [
    { status: 'incomplete', output_text: JSON.stringify(draft()) },
    { status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'No' }] }] },
    { status: 'completed', output_text: '{' },
  ]) {
    await assert.rejects(createDiscoveryComposer(provider, async () => Response.json(payload))({}, signal()));
  }
});

test('structured memory and full acknowledged conversation survive the client’s two-exchange window', async () => {
  let step = 0;
  const seen: CatalogContext[] = [];
  const plan = createCatalogFallback(provider, async (input) => {
    const state = input as CatalogContext;
    seen.push(state);
    return draft({ reply: `A useful direction for turn ${++step}.`, memory: { ...memory(), preferences: [{ value: 'No business advice', basis: 'explicit' }] } });
  });
  const service = new CatalogService(repository(), async (input, abort) => ({ kind: 'clarify', candidateIds: [], fallback: await plan(input, false, abort) }));
  let history: string[] = [];
  for (const utterance of ['No business advice', 'I do not know', 'Help me think', 'Something surprising', 'More about that', 'What else?']) {
    const reply = await service.resolve('a', utterance, undefined, history.slice(-4), signal());
    assert.equal(reply.kind, 'clarify');
    history = [...history, utterance, reply.message];
  }
  assert.equal(seen[5]!.history.length, 10);
  assert.deepEqual(seen[5]!.discovery?.preferences, [{ value: 'No business advice', basis: 'explicit' }]);
  assert.equal((seen[5]!.history[0] as unknown as { text: string }).text, 'No business advice');
  await service.resolve('b', 'Help me', undefined, [], signal());
  assert.deepEqual(seen[6]!.discovery, emptyDiscovery());
  await service.resolve('a', 'A new conversation', undefined, [], signal());
  assert.deepEqual(seen[7]!.discovery, emptyDiscovery());
});

test('rejections and corrections replace preferences, and direct selection still needs independent permission', async () => {
  let step = 0;
  const inputs: CatalogContext[] = [];
  const compose = createCatalogFallback(provider, async (input) => {
    inputs.push(input as CatalogContext);
    return step === 0 ? offer() : draft({
      reply: 'We can leave astronomy aside and look at how public services affect everyday life.',
      memory: { ...memory(), preferences: [{ value: 'Civic services, not astronomy', basis: 'explicit' }], rejectedEpisodeIds: ['missions'] },
    });
  });
  const semantic: typeof askChoices = async <K extends string>() => ({
    action: answer(step < 2 ? 'recommend' : 'choose'), initialAction: answer('none'),
    offerReadiness: answer('offer'),
    offerFeedback: answer(step === 1 ? 'reject_all' : 'keep'),
    catalogMatch: answer('available'), episode: answer('design'), playbackPermission: answer(step === 2 ? 'discovery' : 'requested'),
  }) as Record<K, ChoiceAnswer>;
  const service = new CatalogService(repository(), createCatalogInterpreter({ apiKey: 'test', model: 'test' }, semantic, compose));
  let history: string[] = [];
  for (const utterance of ['Suggest something about space', 'No, civic services instead', 'That sounds interesting', 'Play Accessible public services']) {
    const reply = await service.resolve('a', utterance, undefined, history.slice(-4), signal());
    assert.equal(reply.kind, step === 3 ? 'play' : 'clarify');
    if (step === 3) assert.equal(reply.episode?.id, 'design');
    history.push(utterance, reply.message); step++;
  }
  assert.deepEqual(inputs[2]!.discovery?.rejectedEpisodeIds, ['missions']);
  assert.deepEqual(inputs[1]!.discovery?.rejectedEpisodeIds, ['missions'], 'Semantic rejection must reach the composer before it proposes another option');
  assert.deepEqual(inputs[2]!.discovery?.pendingOffers, []);
});

test('superseded requests cannot return playback or overwrite discovery; another listener is independent', async () => {
  let release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const service = new CatalogService(repository(), async ({ utterance }) => {
    if (utterance === 'old') { await waiting; return { kind: 'select', episodeId: 'space' }; }
    return { kind: 'clarify', candidateIds: [], fallback: { message: 'New direction.', candidateIds: [], discovery: emptyDiscovery() } };
  });
  const old = service.resolve('a', 'old', undefined, [], signal());
  await service.resolve('b', 'other', undefined, [], signal());
  await service.resolve('a', 'new', undefined, [], signal());
  release();
  await assert.rejects(old, { name: 'AbortError' });
});

test('memory expires, resets with episode scope, clears on cancellation, and ignores unacknowledged replies', () => {
  let now = 0;
  const store = new CatalogDiscoveryMemory(() => now, 100, 2);
  const state = { ...emptyDiscovery(), intent: 'Remember me' };
  const commit = (owner: string) => store.begin(owner, undefined, []).commit('u', 'a', state, signal());
  commit('one');
  assert.equal(store.begin('one', undefined, ['u', 'a']).state.intent, 'Remember me');
  assert.equal(store.begin('one', 'space', ['u', 'a']).state.intent, '');
  commit('one');
  assert.equal(store.begin('one', undefined, ['different', 'reply']).state.intent, '');
  commit('one'); now = 101;
  assert.equal(store.begin('one', undefined, ['u', 'a']).state.intent, '');
  commit('one'); commit('two'); commit('three');
  assert.equal(store.begin('one', undefined, ['u', 'a']).state.intent, '');
  commit('one'); store.begin('one', undefined, ['u', 'a']).clear(signal());
  assert.equal(store.begin('one', undefined, ['u', 'a']).state.intent, '');
  commit('one');
  const inFlight = store.begin('one', undefined, ['u', 'a']);
  store.forget('one');
  assert.throws(() => inFlight.commit('later', 'reply', state, signal()), { name: 'AbortError' });
});

test('ordinal order comes from structured offers, with a conservative compatibility path for legacy history', () => {
  assert.deepEqual(recentCatalogOffers({ ...context, discovery: { ...emptyDiscovery(), pendingOffers: [{ option: 1, episodeId: 'missions' }, { option: 2, episodeId: 'space' }] } }), [
    { option: 1, episodeId: 'missions' }, { option: 2, episodeId: 'space' },
  ]);
  const history = ['Suggest something', '“Life beyond Earth” or “Navigating deep space”'];
  assert.deepEqual(recentCatalogOffers({ ...context, history }), [{ option: 1, episodeId: 'missions' }, { option: 2, episodeId: 'space' }]);
  assert.deepEqual(recentCatalogOffers({ ...context, history, discovery: emptyDiscovery() }), [{ option: 1, episodeId: 'missions' }, { option: 2, episodeId: 'space' }]);
  assert.deepEqual(recentCatalogOffers({ ...context, history, discovery: { ...emptyDiscovery(), offeredEpisodeIds: ['missions', 'space'], rejectedEpisodeIds: ['missions'], pendingOffers: [{ option: 2, episodeId: 'space' }] } }), [{ option: 2, episodeId: 'space' }]);
});

test('live multi-turn discovery helps uncertainty, respects corrections and keeps selection separate', { skip: process.env.MURMUR_LIVE_FALLBACK !== '1' }, async () => {
  const config = backendConfig();
  const plans: { candidates: string[]; state: unknown; failure?: string }[] = [];
  const plan = createCatalogFallback(config.providers.openai);
  const service = new CatalogService(repository(), createCatalogInterpreter(config.providers.typesafe, undefined, async (...args) => {
    const result = await plan(...args); plans.push({ candidates: result.candidateIds, state: result.discovery, failure: result.failure }); return result;
  }));
  let history: string[] = [];
  const turn = async (utterance: string, expected: 'clarify' | 'play' = 'clarify') => {
    const result = await service.resolve('live', utterance, undefined, history.slice(-4), signal());
    console.log(JSON.stringify({ utterance, reply: result.message, kind: result.kind, plan: plans.at(-1) }));
    assert.equal(result.kind, expected);
    assert(!result.message.includes('trouble thinking'), result.message);
    assert((result.message.match(/\?/g) ?? []).length <= 1);
    history.push(utterance, result.message);
    return result;
  };
  await turn('Play the Planetary Conversations podcast');
  assert.deepEqual(plans.at(-1)!.candidates, []);
  await turn('I do not know what I like about it. Help me figure out something worth listening to.');
  assert.deepEqual(plans.at(-1)!.candidates, []);
  await turn('I have spent all day on work. Something that makes the world feel bigger sounds good.');
  await turn('I am curious about whether life exists elsewhere. Tell me what you have on that.');
  assert(plans.at(-1)!.candidates.includes('missions'));
  await turn('What makes that a fit for what I told you? Do not play yet.');
  const oldIds = plans.at(-1)!.candidates;
  await turn('Actually leave those aside. I want something grounded in people’s everyday lives, not space.');
  assert(!plans.at(-1)!.candidates.some((id) => oldIds.includes(id)));
  await turn('An interview about making local services more inclusive would work. What is available?');
  assert.deepEqual(plans.at(-1)!.candidates, ['design']);
  assert.equal((await turn('Play that one', 'play')).episode?.id, 'design');
});
