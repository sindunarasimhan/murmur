import assert from 'node:assert/strict';
import test from 'node:test';
import type { PreparedEpisode } from '../shared/listening';
import { askChoices, type ChoiceAnswer, type ChoiceQuestion } from '../src/server/typesafe/client';
import { createCatalogFallback, fallbackResolution, recentCatalogOffers } from './catalog-fallback';
import { createCatalogInterpreter, type CatalogContext } from './catalog-interpreter';
import { CatalogService } from './catalog-service';
import { backendConfig } from './config';

const episodes: PreparedEpisode[] = [
  { id: 'space', title: 'Navigating deep space', showTitle: 'Orbit Notes', guest: 'Maya Chen', description: 'Navigation and mission planning for planetary exploration.', durationSeconds: 3600, status: 'ready', audioVersion: 'a'.repeat(64), audioPath: '/media/space.mp3', transcriptReady: true },
  { id: 'design', title: 'Accessible public services', showTitle: 'Design Fieldwork', guest: 'Inez Costa', description: 'Inclusive design and research for civic services.', durationSeconds: 1800, status: 'ready', audioVersion: 'b'.repeat(64), audioPath: '/media/design.mp3', transcriptReady: true },
  { id: 'missions', title: 'Life beyond Earth', showTitle: 'Science Notebook', guest: 'Ravi Patel', description: 'Planetary exploration and the search for life.', durationSeconds: 2400, status: 'ready', audioVersion: 'c'.repeat(64), audioPath: '/media/missions.mp3', transcriptReady: true },
];
const provider = { apiKey: 'test-only', model: 'test-only' };
const signal = () => new AbortController().signal;
const answer = (choice: string, probabilities = { [choice]: 1 }): ChoiceAnswer => ({ choice, probabilities, confidence: 1 });
const context: CatalogContext = { utterance: 'An interview about planetary exploration', history: [], episodes };
function choices(values: Record<string, ChoiceAnswer>): typeof askChoices {
  return async <K extends string>() => values as Record<K, ChoiceAnswer>;
}
function repository() {
  return { catalog: async () => episodes, unfinished: async () => undefined, charge: async () => {} };
}

test('a known topic yields grounded distinct options and exactly one selection question, never playback', async () => {
  const plan = await createCatalogFallback(provider, choices({ question: answer('offer'), first: answer('missions'), second: answer('space') }))(context, true, signal());
  const result = fallbackResolution(episodes, plan, true);
  assert.equal(result.kind, 'clarify'); assert.equal(result.episode, undefined);
  assert.match(result.message, /couldn’t find that in the catalog/);
  assert(result.message.indexOf(episodes[2]!.title) < result.message.indexOf(episodes[0]!.title));
  for (const episode of [episodes[2]!, episodes[0]!]) {
    assert(result.message.includes(episode.description));
    assert(result.message.includes(episode.showTitle));
  }
  assert(!result.message.includes(episodes[1]!.title));
  assert.equal(result.message.match(/\?/g)?.length, 1);
});

test('unavailable content without an expressed interest asks one useful question instead of listing the catalog', async () => {
  const plan = await createCatalogFallback(provider, choices({ question: answer('interest'), first: answer('space'), second: answer('design') }))({ ...context, utterance: 'Play an unavailable show' }, true, signal());
  assert.deepEqual(plan.candidateIds, []);
  const result = fallbackResolution(episodes, plan, true);
  assert.match(result.message, /What drew you to it/);
  assert.equal(result.message.match(/\?/g)?.length, 1);
  episodes.forEach((episode) => assert(!result.message.includes(episode.title)));
});

test('planner receives complete contextual preferences, corrections, active episode, duration and role-tagged history', async () => {
  const history = ['I want astronomy', 'Would you prefer depth or a lighter conversation?', 'Actually, public-service design, and keep it short', 'I can look for a shorter design conversation.'];
  const input = { ...context, utterance: 'Something practical', history, currentEpisodeId: 'space' };
  const inspect: typeof askChoices = async <K extends string>(state: unknown, questions: Record<K, ChoiceQuestion>) => {
    assert.deepEqual(state, { ...input, unavailable: false, history: history.map((text, index) => ({ role: index % 2 ? 'assistant' : 'user', text })) });
    assert.deepEqual(Object.keys((questions as Record<string, ChoiceQuestion>).first!.criteria), [...episodes.map((episode) => episode.id), 'none']);
    return { question: answer('offer'), first: answer('design'), second: answer('none') } as Record<K, ChoiceAnswer>;
  };
  const result = await createCatalogFallback(provider, inspect)(input, false, signal());
  assert.deepEqual(result.candidateIds, ['design']);
});

test('unknown, duplicate, low-confidence or absent options cannot become recommendations or playback', async () => {
  for (const [first, second, expected] of [
    [answer('invented'), answer('none'), []],
    [answer('space'), answer('space'), ['space']],
    [answer('space', { space: 0.6, none: 0.4 }), answer('none'), []],
    [answer('none'), answer('none'), []],
  ] as const) {
    const plan = await createCatalogFallback(provider, choices({ question: answer('offer'), first, second }))(context, false, signal());
    assert.deepEqual(plan.candidateIds, expected);
    const result = fallbackResolution(episodes, plan);
    assert.equal(result.kind, 'clarify'); assert.equal(result.episode, undefined);
    assert(!result.message.includes('invented'));
  }
  const stale = fallbackResolution([], { question: 'offer', candidateIds: ['space'] });
  assert.equal(stale.kind, 'clarify'); assert(!stale.message.includes(episodes[0]!.title));
});

test('planner failure fails closed and cancellation propagates even if the provider returns late', async () => {
  const failed = createCatalogFallback(provider, async () => { throw new Error('provider down'); });
  assert.deepEqual(await failed(context, true, signal()), { question: 'interest', candidateIds: [] });
  const controller = new AbortController();
  const late: typeof askChoices = async <K extends string>() => {
    controller.abort();
    return { question: answer('offer'), first: answer('space'), second: answer('none') } as Record<K, ChoiceAnswer>;
  };
  await assert.rejects(createCatalogFallback(provider, late)(context, false, controller.signal), { name: 'AbortError' });
});

test('multi-turn discovery remembers the request, offers alternatives, and plays only after explicit selection', async () => {
  const seen: CatalogContext[] = [];
  let turn = 0;
  const semantic: typeof askChoices = async <K extends string>(state: unknown, questions: Record<K, ChoiceQuestion>) => {
    const all = questions as Record<string, ChoiceQuestion>;
    if (all.action) {
      seen.push(state as CatalogContext);
      return { action: answer(turn === 1 ? 'recommend' : 'choose'), initialAction: answer('none') } as Record<K, ChoiceAnswer>;
    }
    if (all.catalogMatch) return { catalogMatch: answer(turn === 0 ? 'unavailable' : 'available'), episode: answer(turn === 0 ? 'none' : 'missions'), playbackPermission: answer('requested') } as Record<K, ChoiceAnswer>;
    return { question: answer(turn === 0 ? 'interest' : 'offer'), first: answer(turn === 0 ? 'none' : 'space'), second: answer(turn === 0 ? 'none' : 'missions') } as Record<K, ChoiceAnswer>;
  };
  const service = new CatalogService(repository(), createCatalogInterpreter(provider, semantic));
  const request = 'Play the unavailable science show';
  const first = await service.resolve('listener', request, undefined, [], signal());
  assert.equal(first.kind, 'clarify');
  turn = 1;
  const preference = 'I’m interested in planetary exploration';
  const history = [request, first.message];
  const second = await service.resolve('listener', preference, undefined, history, signal());
  assert.equal(second.kind, 'clarify'); assert.equal(second.episode, undefined);
  turn = 2;
  const finalHistory = [...history, preference, second.message];
  const selected = await service.resolve('listener', 'The second one, please', undefined, finalHistory, signal());
  assert.equal(selected.kind, 'play'); assert.equal(selected.episode?.id, 'missions');
  assert.deepEqual(seen[2]!.history, finalHistory.map((text, index) => ({ role: index % 2 ? 'assistant' : 'user', text })));
});

test('even a confident available match requires permission; preference answers and ambiguous yes remain discovery', async () => {
  for (const utterance of ['The shorter one sounds interesting', 'Yes', 'More about design']) {
    const semantic = choices({ action: answer('choose'), initialAction: answer('none'), catalogMatch: answer('available'), episode: answer('design'), playbackPermission: answer('discovery'), question: answer('offer'), first: answer('design'), second: answer('none') });
    const service = new CatalogService(repository(), createCatalogInterpreter(provider, semantic));
    const result = await service.resolve('listener', utterance, undefined, ['Find a podcast', 'Would you prefer astronomy or design?'], signal());
    assert.equal(result.kind, 'clarify'); assert.equal(result.episode, undefined);
  }
});

test('resume without a saved session does not start even a sole catalog episode', async () => {
  const service = new CatalogService({ ...repository(), catalog: async () => [episodes[0]!] }, async () => ({ kind: 'resume' }));
  const result = await service.resolve('listener', 'Resume', undefined, [], signal());
  assert.equal(result.kind, 'clarify'); assert.equal(result.episode, undefined);
});

test('spoken options remain within the existing native history budget', () => {
  const large = episodes.map((episode) => ({ ...episode, title: 'A long title '.repeat(40), showTitle: 'A long show '.repeat(40), description: 'Long catalog description. '.repeat(100) }));
  const result = fallbackResolution(large, { question: 'offer', candidateIds: ['space', 'design'] }, true);
  assert(result.message.length <= 1000);
  assert(result.message.endsWith('Which would you like to play?'));
});

test('offer references preserve spoken order and reject stale or ambiguous display titles', () => {
  const reply = fallbackResolution(episodes, { question: 'offer', candidateIds: ['missions', 'space'] }).message;
  assert.deepEqual(recentCatalogOffers({ ...context, history: ['Suggestions?', reply] }), [{ option: 1, episodeId: 'missions' }, { option: 2, episodeId: 'space' }]);
  assert.deepEqual(recentCatalogOffers({ ...context, history: ['Suggestions?', reply, 'Actually, design', 'What style would you like?'] }), []);
  const duplicates = [...episodes, { ...episodes[2]!, id: 'duplicate-title' }];
  assert.deepEqual(recentCatalogOffers({ ...context, episodes: duplicates, history: ['Suggestions?', reply] }), [{ option: 2, episodeId: 'space' }]);
});

test('similarly relevant alternatives need not collapse to an arbitrary winner before offering choices', async () => {
  const plan = await createCatalogFallback(provider, choices({ question: answer('offer'), first: answer('missions', { missions: 0.52, space: 0.47, none: 0.01 }), second: answer('space', { space: 0.52, missions: 0.47, none: 0.01 }) }))(context, false, signal());
  assert.deepEqual(plan.candidateIds, ['missions', 'space']);
  assert.equal(fallbackResolution(episodes, plan).kind, 'clarify');
});

test('live model handles contextual discovery, refusal, ordinal selection and existing controls', { skip: process.env.MURMUR_LIVE_FALLBACK !== '1' }, async () => {
  const config = backendConfig();
  assert(config.providers.typesafe.apiKey, 'Live evaluation requires configured TypeSafe credentials');
  const inspect: typeof askChoices = async (state, questions, options) => {
    const answers = await askChoices(state, questions, options);
    console.log(JSON.stringify({ decisions: answers }));
    return answers;
  };
  const service = new CatalogService(repository(), createCatalogInterpreter(config.providers.typesafe, inspect));
  const first = await service.resolve('evaluation', 'Play the Planetary Conversations podcast', undefined, [], signal());
  assert.equal(first.kind, 'clarify'); assert.equal(first.episode, undefined);
  assert.match(first.message, /couldn’t find/);
  const history = ['Play the Planetary Conversations podcast', first.message];
  const second = await service.resolve('evaluation', 'It is the planetary exploration I enjoy, rather than a particular host. What else is available?', undefined, history, signal());
  assert.equal(second.kind, 'clarify'); assert.equal(second.episode, undefined);
  assert(second.message.includes(episodes[0]!.title) || second.message.includes(episodes[2]!.title), second.message);
  assert(!second.message.includes(episodes[1]!.title), second.message);
  const followup = [...history, 'It is the planetary exploration I enjoy, rather than a particular host. What else is available?', second.message];
  const unselected = await service.resolve('evaluation', 'That sounds interesting, but don’t play anything yet', undefined, followup, signal());
  assert.notEqual(unselected.kind, 'play');
  const offered = episodes.filter((episode) => second.message.includes(episode.title)).sort((a, b) => second.message.indexOf(a.title) - second.message.indexOf(b.title));
  const selected = await service.resolve('evaluation', 'Play the first one', undefined, followup, signal());
  assert.equal(selected.kind, 'play'); assert.equal(selected.episode?.id, offered[0]!.id);
  for (const [utterance, expected] of [['Pause this episode', 'current'], ['Resume the podcast', 'current'], ['Seek to ten minutes', 'current'], ['Never mind', 'cancel'], ['End this episode', 'home']] as const) {
    const result = await service.resolve('evaluation', utterance, 'space', [], signal());
    assert.equal(result.kind, expected, utterance);
  }
  console.log(JSON.stringify({ unavailable: first.message, alternatives: second.message, selected: selected.episode?.title, verification: 'Live model with a fixture catalog; no microphone or audio playback' }));
});

test('live discovery follows corrections, guest and length preferences without autoplay', { skip: process.env.MURMUR_LIVE_FALLBACK !== '1' }, async () => {
  const service = new CatalogService(repository(), createCatalogInterpreter(backendConfig().providers.typesafe));
  const oldOffer = fallbackResolution(episodes, { question: 'offer', candidateIds: ['missions', 'space'] }).message;
  for (const [utterance, history, expected] of [
    ['Recommend a practical interview about making public services inclusive, around half an hour', [], 'design'],
    ['What could I hear featuring Inez Costa?', [], 'design'],
    ['Actually, forget astronomy. I would like recommendations about accessible civic services instead.', ['Suggest astronomy', oldOffer], 'design'],
  ] as const) {
    const result = await service.resolve('evaluation', utterance, undefined, [...history], signal());
    assert.equal(result.kind, 'clarify', utterance); assert.equal(result.episode, undefined);
    assert(result.message.includes(episodes.find((episode) => episode.id === expected)!.title), result.message);
  }
  const unsure = await service.resolve('evaluation', 'I’m not sure what I want to hear', undefined, [], signal());
  assert.equal(unsure.kind, 'clarify'); assert.equal(unsure.episode, undefined);
  const offer = fallbackResolution(episodes, { question: 'offer', candidateIds: ['design'] }).message;
  const accepted = await service.resolve('evaluation', 'Yes, play it please', undefined, ['Suggest a design interview', offer], signal());
  assert.equal(accepted.kind, 'play'); assert.equal(accepted.episode?.id, 'design');
  for (const episode of episodes) {
    const selected = await service.resolve('evaluation', `Play ${episode.title}`, undefined, [], signal());
    assert.equal(selected.kind, 'play', episode.title); assert.equal(selected.episode?.id, episode.id);
  }
});
