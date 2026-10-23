import assert from 'node:assert/strict';
import test from 'node:test';
import type { PreparedEpisode } from '../shared/listening';
import { type askChoices, type ChoiceAnswer } from '../src/server/typesafe/client';
import { createCatalogFallback, createDiscoveryComposer, fallbackResolution, recentCatalogOffers, type DiscoveryDraft } from './catalog-fallback';
import { createCatalogInterpreter, type CatalogContext } from './catalog-interpreter';
import { CatalogService } from './catalog-service';
import { CatalogDiscoveryMemory, emptyDiscovery } from './catalog-discovery';
import { catalogLabels } from './catalog-labels';
import { backendConfig } from './config';

const episodes: PreparedEpisode[] = [
  { id: 'space', title: 'Navigating deep space', showTitle: 'Orbit Notes', guest: 'Maya Chen', description: 'Navigation and mission planning for planetary exploration.', durationSeconds: 3600, status: 'ready', audioVersion: 'a'.repeat(64), audioPath: '/media/space.mp3', transcriptReady: true },
  { id: 'design', title: 'Accessible public services', showTitle: 'Design Fieldwork', guest: 'Inez Costa', description: 'Inclusive design and research for civic services.', durationSeconds: 1800, status: 'ready', audioVersion: 'b'.repeat(64), audioPath: '/media/design.mp3', transcriptReady: true },
  { id: 'missions', title: 'Life beyond Earth', showTitle: 'Science Notebook', guest: 'Ravi Patel', description: 'Planetary exploration and the search for life.', durationSeconds: 2400, status: 'ready', audioVersion: 'c'.repeat(64), audioPath: '/media/missions.mp3', transcriptReady: true },
];
const provider = { ...backendConfig().providers.openai, apiKey: 'test-only' };
const signal = () => new AbortController().signal;
const context: CatalogContext = { utterance: 'Help me figure it out', history: [], episodes };
const answer = (choice: string): ChoiceAnswer => ({ choice, probabilities: { [choice]: 1 }, confidence: 1 });
const repository = () => ({ catalog: async () => episodes, unfinished: async () => undefined, charge: async () => {} });
const memory = () => ({ intent: 'Find something interesting', preferences: [], unknowns: [], rejectedEpisodeIds: [] });
const draft = (overrides: Partial<DiscoveryDraft> = {}): DiscoveryDraft => ({
  reply: 'We could follow the question of whether life exists elsewhere. That gives us a mystery to explore without choosing an episode yet.',
  responseKind: 'hold', question: null, offers: [], memory: memory(), ...overrides,
});
const offer = (): DiscoveryDraft => draft({
  reply: '',
  responseKind: 'offer', offers: [{ episodeId: 'missions', evidenceField: 'description', reason: 'It follows the search for life beyond our planet, a possible starting point for your curiosity.' }],
});

test('grounded offers use short stable names and ask for selection without playing', async () => {
  const options = await createCatalogFallback(provider, async () => offer())(context, false, signal());
  assert.equal(options.failure, undefined);
  assert(options.message.includes('Ravi Patel’s episode'));
  assert(options.message.endsWith('Want to listen?'));
  assert.deepEqual(options.discovery?.pendingOffers, [{ option: 1, episodeId: 'missions', label: 'Ravi Patel’s episode' }]);
  assert.equal(fallbackResolution(episodes, options).kind, 'clarify');
  const named = await createCatalogFallback(provider, async () => offerWithNamedReference())(context, false, signal());
  assert.deepEqual(named.candidateIds, ['missions']);
  assert(named.message.includes('Ravi Patel’s episode'));
});

function offerWithNamedReference(): DiscoveryDraft {
  return offer();
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
    if (calls === 1) return draft({ reply: 'Consider [[missions]].' });
    assert.equal((input as { repair: { reason: string } }).repair.reason, 'invalid_option_references');
    return draft();
  })(context, false, signal());
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
    assert.equal(request.text.format.schema.properties.question.type, 'null');
    assert(!request.text.format.schema.properties.responseKind.enum.includes('question'), 'No question mode after the budget');
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
  assert.equal(seen[5]!.history.length, 11);
  assert.deepEqual(seen[5]!.history.at(-1), { role: 'user', text: 'What else?' });
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
    offerReply: answer('other'),
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
  const generate = createDiscoveryComposer(config.providers.openai);
  const plan = createCatalogFallback(config.providers.openai, async (input, abort) => {
    const draft = await generate(input, abort);
    console.log(JSON.stringify({ draft, responseMode: (input as CatalogContext).discoveryResponse }));
    return draft;
  });
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
  assert(plans.at(-1)!.candidates.length > 0, 'Unavailable path must offer after at most one question, even if the listener remains unsure');
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

test('server budget survives the client window and cannot be reset by a model draft or correction', async () => {
  const seen: number[] = [];
  const compose = createCatalogFallback(provider, async (input) => {
    const remaining = (input as { discoveryQuestionsRemaining: number }).discoveryQuestionsRemaining;
    seen.push(remaining);
    return remaining ? draft({ responseKind: 'question', reply: '', question: remaining === 2 ? 'What are you curious about today?' : 'Would exploring space be interesting?' }) : offer();
  });
  const service = new CatalogService(repository(), async (input, abort) => ({ kind: 'clarify', candidateIds: [], fallback: await compose(input, false, abort) }));
  const history: string[] = [];
  for (const utterance of ['Help me choose', 'Not sure', 'Still unsure', 'Actually something different', 'Tell me more']) {
    const result = await service.resolve('budget', utterance, undefined, history.slice(-4), signal());
    assert.equal(result.kind, 'clarify');
    history.push(utterance, result.message);
  }
  assert.deepEqual(seen, [2, 1, 0, 0, 0]);
  const exhausted = { ...context, discovery: { ...emptyDiscovery(), discoveryQuestions: 2 } };
  const result = await createCatalogFallback(provider, async () => draft({ responseKind: 'question', question: 'One more preference?' }))(exhausted, false, signal());
  assert.equal(result.failure, 'question_budget_exhausted');
  assert.equal(result.discovery?.discoveryQuestions, 2);
});

test('unavailable request allows only one question and context can skip it entirely', async () => {
  const inputs: number[] = [];
  const compose = createCatalogFallback(provider, async (input) => {
    const remaining = (input as { discoveryQuestionsRemaining: number }).discoveryQuestionsRemaining;
    inputs.push(remaining);
    return remaining ? draft({ responseKind: 'question', reply: 'That is unavailable.', question: 'What interested you in it?' }) : offer();
  });
  const first = await compose(context, true, signal());
  assert.equal(first.discovery?.questionLimit, 1);
  const second = await compose({ ...context, discovery: first.discovery }, false, signal());
  assert.deepEqual(inputs, [1, 0]);
  assert.deepEqual(second.candidateIds, ['missions']);
  assert.equal(second.discovery?.discoveryQuestions, 1);
  const ready = await createCatalogFallback(provider, async () => offer())(context, true, signal());
  assert.equal(ready.discovery?.discoveryQuestions, 0);
  assert.deepEqual(ready.candidateIds, ['missions']);
});

test('no supported fit remains honest after the question budget, and rejected drafts do not consume questions', async () => {
  const noFit = await createCatalogFallback(provider, async () => draft({ responseKind: 'no_match', reply: 'I do not have a match for that subject.' }))({ ...context, discovery: { ...emptyDiscovery(), discoveryQuestions: 2 } }, false, signal());
  assert.equal(noFit.failure, undefined);
  assert.deepEqual(noFit.candidateIds, []);
  assert.equal(fallbackResolution(episodes, noFit).kind, 'clarify');
  let calls = 0;
  const repaired = await createCatalogFallback(provider, async () => ++calls === 1 ? draft({ responseKind: 'question', question: 'What topic? What style?' }) : draft({ responseKind: 'question', reply: '', question: 'What has caught your attention lately?' }))(context, false, signal());
  assert.equal(repaired.discovery?.discoveryQuestions, 1);
  assert.equal(calls, 2);
});

test('short labels are grounded, distinct and map to the spoken order after a follow-up', async () => {
  const long = { ...episodes[0]!, title: 'A very long episode title that nobody should have to listen to in full before choosing a podcast | Maya Chen' };
  const catalog = [long, { ...long, id: 'second', title: 'Another journey through the outer planets | Maya Chen' }, ...episodes.slice(1)];
  const labels = catalogLabels(catalog);
  assert.equal(labels.get('space'), 'Maya Chen’s episode');
  assert.notEqual(labels.get('space'), labels.get('second'));
  assert([...labels.values()].every((label) => label.length < 110));
  const two = draft({ responseKind: 'offer', reply: '', offers: [offer().offers[0]!, { episodeId: 'space', evidenceField: 'description', reason: 'It follows planetary navigation.' }] });
  const first = await createCatalogFallback(provider, async () => two)({ ...context, maxOffers: 2 }, false, signal());
  assert(first.message.endsWith('Which would you like to hear?'));
  assert.deepEqual(first.discovery?.pendingOffers.map((o) => o.episodeId), ['missions', 'space']);
  const next = await createCatalogFallback(provider, async () => ({ ...two, offers: [], responseKind: 'answer', reply: '[[space]] is about navigation, while [[missions]] focuses on life elsewhere.' }))({ ...context, discovery: first.discovery }, false, signal());
  assert.equal(next.failure, undefined);
  assert.deepEqual(next.discovery?.pendingOffers.map((o) => o.episodeId), ['space', 'missions']);
  assert.equal(next.discovery?.pendingOffers[1]?.label, first.discovery?.pendingOffers[0]?.label);
  assert.deepEqual(recentCatalogOffers({ ...context, history: ['Suggest one', first.message] }).map((o) => o.episodeId), ['missions', 'space']);
});

test('a clear authorized first request bypasses discovery and ambiguous two-option acceptance asks only which', async () => {
  let mode = 'play'; let fallbackCalls = 0;
  const semantic: typeof askChoices = async <K extends string>() => ({
    action: answer(mode === 'play' ? 'choose' : 'recommend'), initialAction: answer('none'),
    catalogMatch: answer('available'), episode: answer('missions'), playbackPermission: answer('requested'),
    offerReply: answer('ambiguous_acceptance'), offerFeedback: answer('keep'),
  }) as Record<K, ChoiceAnswer>;
  const interpret = createCatalogInterpreter({ apiKey: 'test', model: 'test' }, semantic, async () => { fallbackCalls++; throw new Error('Should not compose'); });
  assert.deepEqual(await interpret({ ...context, utterance: 'Play Science Notebook' }, signal()), { kind: 'select', episodeId: 'missions' });
  mode = 'ambiguous';
  const discovery = { ...emptyDiscovery(), discoveryQuestions: 2, pendingOffers: [{ option: 1, episodeId: 'missions', label: 'Ravi Patel’s episode' }, { option: 2, episodeId: 'space', label: 'Maya Chen’s episode' }] };
  const result = await interpret({ ...context, utterance: 'Yes', discovery }, signal());
  assert.equal(result.kind, 'clarify');
  if (result.kind === 'clarify') {
    assert.match(result.fallback!.message, /^Which would you like:/);
    assert.deepEqual(result.fallback!.discovery, discovery);
    assert.equal(result.fallback!.responseKind, 'selection');
  }
  assert.equal(fallbackCalls, 0);
});

test('even repeated semantic requests to ask cannot exceed the persisted budget', async () => {
  const modes: string[] = [];
  const semantic: typeof askChoices = async <K extends string>() => ({
    action: answer('recommend'), initialAction: answer('none'), discoveryResponse: answer('question'),
    offerReply: answer('other'), offerFeedback: answer('keep'), offerCount: answer('one'),
  }) as Record<K, ChoiceAnswer>;
  const composer = createCatalogFallback(provider, async (input) => {
    const state = input as CatalogContext;
    modes.push(state.discoveryResponse!);
    return state.discoveryResponse === 'question' ? draft({ responseKind: 'question', reply: '', question: modes.length === 1 ? 'What interests you today?' : 'Would a science conversation appeal?' }) : offer();
  });
  const service = new CatalogService(repository(), createCatalogInterpreter({ apiKey: 'test', model: 'test' }, semantic, composer));
  const history: string[] = [];
  for (const utterance of ['Help choose', 'Unsure', 'Still unsure']) {
    const reply = await service.resolve('bounded-router', utterance, undefined, history.slice(-4), signal());
    history.push(utterance, reply.message);
  }
  assert.deepEqual(modes, ['question', 'question', 'offer']);
  assert(history.at(-1)!.includes('Ravi Patel’s episode'));
});

test('an explanation can reference an existing offer without proposing it again or asking consent', async () => {
  const previous = (await createCatalogFallback(provider, async () => offer())(context, false, signal())).discovery;
  const response = await createCatalogFallback(provider, async () => draft({ responseKind: 'answer', reply: '[[missions]] covers planetary exploration and the search for life.' }))({ ...context, discovery: previous, discoveryResponse: 'answer' }, false, signal());
  assert.equal(response.failure, undefined);
  assert(!response.message.includes('?'));
  assert.deepEqual(response.candidateIds, ['missions']);
  assert.deepEqual(response.discovery?.pendingOffers, previous?.pendingOffers);
});
