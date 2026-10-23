import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalogInterpreter, type CatalogContext } from './catalog-interpreter';
import { backendConfig } from './config';
import { createDatabase } from './database';
import { Repository } from './repository';
import { type askChoices, type ChoiceAnswer } from '../src/server/typesafe/client';

const episodes: CatalogContext['episodes'] = [
  { id: 'cat', title: 'Building AI products', showTitle: 'Lenny’s Podcast', guest: 'Cat Wu', description: 'Product work at Anthropic.' },
  { id: 'brian', title: 'Lessons in leadership', showTitle: 'Lenny’s Podcast', guest: 'Brian Halligan', description: 'Building HubSpot and leading teams.' },
  { id: 'orbit', title: 'Navigating deep space', showTitle: 'Orbit Notes', guest: 'Maya Chen', description: 'Planning interplanetary missions.' },
];
const variants = [
  'Can you play the Cat Wu episode from Lenny’s Pod',
  'Can you play the Cat Wu episode from Lenny’s Podcast',
  'Could you play the um Lenny’s podcast Cat Wu episode please',
  'From Lenny’s show, the interview with Cat Wu, please',
  'Not Brian Halligan — I meant Cat Wu on Lenny’s show',
];
const answer = (choice: string, probabilities = { [choice]: 1 }): ChoiceAnswer => ({ choice, probabilities, confidence: 1 });
const provider = { apiKey: 'test-only', model: 'test-only' };
const signal = () => new AbortController().signal;

test('catalog choices reference complete metadata without duplicating descriptions', async () => {
  const large = Array.from({ length: 72 }, (_, index) => ({
    ...episodes[index % episodes.length]!, id: `episode-${index}`,
    description: `Unique description ${index}: ${'Additional published episode context. '.repeat(50)}`,
  }));
  let checked = false;
  const choices: typeof askChoices = async <K extends string>(state: unknown, questions: Record<K, unknown>) => {
    assert.deepEqual((state as CatalogContext).episodes, large);
    if ('episode' in questions) {
      checked = true;
      const criteria = (questions.episode as { criteria: Record<string, string> }).criteria;
      assert.equal(Object.keys(criteria).length, large.length + 1);
      large.forEach((episode, index) => assert.equal(criteria[episode.id], `The episode described in episodes[${index}].`));
      assert(JSON.stringify(questions).length < 12000, 'Questions must not embed a second copy of the catalog');
    }
    return { action: answer('choose'), initialAction: answer('none'), catalogMatch: answer('available'), playbackPermission: answer('requested'), episode: answer(large[0]!.id) } as Record<K, ChoiceAnswer>;
  };
  assert.deepEqual(await createCatalogInterpreter(provider, choices)({ utterance: 'Choose the requested interview', episodes: large, history: [] }, signal()), { kind: 'select', episodeId: large[0]!.id });
  assert(checked);
});

test('current-episode routing stops before catalog selection while a switch reaches matching', async () => {
  for (const action of ['current', 'resume', 'choose']) {
    const phases: string[][] = [];
    const choices: typeof askChoices = async <K extends string>(_state: unknown, questions: Record<K, unknown>) => {
      phases.push(Object.keys(questions));
      return { action: answer(action), initialAction: answer('none'), catalogMatch: answer('available'), playbackPermission: answer('requested'), episode: answer('brian') } as Record<K, ChoiceAnswer>;
    };
    const result = await createCatalogInterpreter(provider, choices)({ utterance: 'A completed contextual request', currentEpisodeId: 'cat', history: [], episodes }, signal());
    assert.deepEqual(result, action === 'choose' ? { kind: 'select', episodeId: 'brian' } : { kind: action });
    assert.equal(phases.length, action === 'choose' ? 2 : 1);
  }
});

test('every matching variant reaches interpretation with full text, history and all eligible IDs', async () => {
  for (const utterance of variants) {
    const history = ['Which guest?', 'Cat Wu or Brian Halligan?'];
    let calls = 0;
    const choices: typeof askChoices = async <K extends string>(state: unknown, questions: Record<K, unknown>) => {
      calls++;
      assert.deepEqual(state, { utterance, episodes, currentEpisodeId: 'orbit', recentOffers: [], history: [
        { role: 'user', text: history[0] }, { role: 'assistant', text: history[1] },
      ] });
      if ('episode' in questions) {
        const question = questions.episode as { criteria: Record<string, string> };
        assert.deepEqual(Object.keys(question.criteria), [...episodes.map((episode) => episode.id), 'none']);
      }
      return { action: answer('choose'), initialAction: answer('none'), catalogMatch: answer('available'), playbackPermission: answer('requested'), episode: answer('cat') } as Record<K, ChoiceAnswer>;
    };
    const result = await createCatalogInterpreter(provider, choices)({ utterance, history, currentEpisodeId: 'orbit', episodes }, signal());
    assert.deepEqual(result, { kind: 'select', episodeId: 'cat' }, utterance);
    assert.equal(calls, 2, 'Neither selection nor rejection may bypass semantic matching');
  }
});

test('an exact lexical match cannot override semantic negation, ambiguity, absence or service failure', async () => {
  const context = { utterance: 'Play Cat Wu from Lenny’s Podcast', history: [], episodes };
  for (const [match, selected, expected] of [
    [answer('unavailable'), answer('none'), 'unavailable'],
    [answer('unspecified'), answer('none'), undefined],
    [answer('available'), answer('cat', { cat: 0.5, brian: 0.5 }), undefined],
    [answer('available'), answer('invented'), undefined],
  ] as const) {
    const choices: typeof askChoices = async <K extends string>() => ({ action: answer('choose'), initialAction: answer('none'), catalogMatch: match, episode: selected }) as Record<K, ChoiceAnswer>;
    const result = await createCatalogInterpreter(provider, choices)(context, signal());
    assert.equal(result.kind, 'clarify');
    assert.equal(result.kind === 'clarify' ? result.reason : null, expected);
  }
  const failed = createCatalogInterpreter(provider, async () => { throw new Error('Provider unavailable'); });
  await assert.rejects(failed(context, signal()), /Provider unavailable/);
  const cancel: typeof askChoices = async <K extends string>() => ({ action: answer('cancel'), initialAction: answer('none') }) as Record<K, ChoiceAnswer>;
  assert.deepEqual(await createCatalogInterpreter(provider, cancel)({ ...context, utterance: 'Do not play Cat Wu' }, signal()), { kind: 'cancel' });
});

test('live semantic matching understands added context and paraphrases without lexical shortcuts', { skip: process.env.MURMUR_LIVE_MATCHING !== '1' }, async () => {
  const interpret = createCatalogInterpreter(backendConfig().providers.typesafe);
  const cases = [
    ...variants.map((utterance) => ({ utterance, expected: 'cat' })),
    { utterance: 'Put on the one about finding your way between planets', expected: 'orbit' },
    { utterance: 'Play Maya Chen from Lenny’s Podcast', expected: undefined },
    { utterance: 'Play Joe Rogan', expected: undefined },
    { utterance: 'Do not play the Cat Wu episode', expected: undefined },
  ];
  for (const { utterance, expected } of cases) {
    const result = await interpret({ utterance, history: [], episodes }, signal());
    assert.equal(result.kind === 'select' ? result.episodeId : undefined, expected, `${utterance}: ${JSON.stringify(result)}`);
    if (expected === undefined) assert.notEqual(result.kind, 'recommend', utterance);
  }
});

test('live matching preserves guest and show context against the actual stored catalog', { skip: process.env.MURMUR_LIVE_MATCHING !== '1' }, async () => {
  const config = backendConfig();
  const pool = createDatabase(config.databaseUrl);
  const catalog = await new Repository(pool, config).catalog().finally(() => pool.end());
  const expected = catalog.find((episode) => episode.guest === 'Cat Wu');
  assert(expected, 'The reported regression fixture must exist in the test catalog');
  const interpret = createCatalogInterpreter(config.providers.typesafe);
  for (const utterance of variants) {
    const result = await interpret({ utterance, history: [], episodes: catalog }, signal());
    assert.deepEqual(result, { kind: 'select', episodeId: expected.id }, utterance);
  }
});

test('live production-sized catalog supports controls, discussion and switching midstream', { skip: !process.env.MURMUR_MATCHING_CATALOG_URL }, async () => {
  const response = await fetch(process.env.MURMUR_MATCHING_CATALOG_URL!, { signal: AbortSignal.timeout(15000) });
  assert(response.ok, 'Catalog snapshot must load successfully');
  const catalog = await response.json() as CatalogContext['episodes'];
  const metadata = catalog.map(({ id, title, showTitle, guest, description }) => ({ id, title, showTitle, guest, description }));
  const current = metadata.find((episode) => episode.guest === 'Cat Wu');
  const next = metadata.find((episode) => episode.guest === 'Brian Halligan');
  assert(current && next, 'Both episode fixtures must be present');
  const interpret = createCatalogInterpreter(backendConfig().providers.typesafe);
  const history = ['What does product taste mean?', 'It is judgment about which product choices serve users well.'];
  const cases = [
    ['Pause', 'current'], ['Skip this ad', 'current'], ['Skip all ads in this podcast', 'current'],
    ['Tell me more about the podcast guest’s point', 'current'], ['How do you develop that?', 'current'],
    ['Continue playing this episode', 'resume'], ['Play Brian Halligan instead', 'select'],
  ] as const;
  for (const [utterance, expectedKind] of cases) {
    const result = await interpret({ utterance, currentEpisodeId: current.id, history, episodes: metadata }, signal());
    assert.equal(result.kind, expectedKind, `${utterance}: ${JSON.stringify(result)}`);
    if (result.kind === 'select') assert.equal(result.episodeId, next.id);
  }
  for (const utterance of variants) {
    assert.deepEqual(await interpret({ utterance, history: [], episodes: metadata }, signal()), { kind: 'select', episodeId: current.id }, utterance);
  }
});
