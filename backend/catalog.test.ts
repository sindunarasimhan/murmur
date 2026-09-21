import assert from 'node:assert/strict';
import test from 'node:test';
import type { PreparedEpisode } from '../shared/listening';
import type { askChoices, ChoiceAnswer } from '../src/server/typesafe/client';
import { createCatalogInterpreter, type CatalogContext, type CatalogIntent, type CatalogInterpreter } from './catalog-interpreter';
import { CatalogService } from './catalog-service';

const mars: PreparedEpisode = {
  id: 'orbit-mars', title: 'Finding our way to Mars', showTitle: 'Orbit Notes', guest: 'Maya Chen',
  description: 'Navigation and mission planning for deep-space exploration.',
  durationSeconds: 3600, status: 'ready', audioVersion: 'a'.repeat(64), audioPath: '/media/mars.mp3', transcriptReady: true,
};
const design: PreparedEpisode = {
  ...mars, id: 'design-fieldwork', title: 'Making public services accessible', showTitle: 'Design Fieldwork',
  guest: 'Inez Costa', description: 'Research and inclusive design for civic services.',
};
const signal = () => new AbortController().signal;
const context: CatalogContext = { utterance: 'Find the Mars interview', episodes: [mars, design], history: [] };

function service(episodes: PreparedEpisode[], interpret: CatalogInterpreter, unfinished?: PreparedEpisode) {
  return new CatalogService({ catalog: async () => episodes, unfinished: async () => unfinished, charge: async () => {} }, interpret);
}
function decisions(answers: Record<string, ChoiceAnswer>): typeof askChoices {
  return async <K extends string>() => answers as Record<K, ChoiceAnswer>;
}
function choice(value: string, probabilities: Record<string, number> = { [value]: 1 }): ChoiceAnswer {
  return { choice: value, confidence: 1, probabilities };
}
function interpreter(overrides: Partial<Record<'action' | 'catalogMatch' | 'episode', ChoiceAnswer>> = {}) {
  return createCatalogInterpreter({ apiKey: 'test-only', model: 'test-only' }, decisions({
    action: choice('choose'), catalogMatch: choice('available'), episode: choice(mars.id), ...overrides,
  }));
}

test('selection and announcements follow catalog metadata when the entire catalog changes', async () => {
  for (const episode of [mars, design]) {
    let observed: CatalogContext | undefined;
    const catalog = service([episode], async (input) => {
      observed = input;
      return { kind: 'select', episodeId: input.episodes[0]!.id };
    });
    const result = await catalog.resolve('owner', `Play ${episode.showTitle}`, undefined, [], signal());
    assert.equal(result.episode?.id, episode.id);
    assert.equal(result.message, `${episode.showTitle}. With ${episode.guest}.`);
    assert.equal(observed?.episodes[0]?.showTitle, episode.showTitle);
    assert.equal(Object.hasOwn(observed!.episodes[0]!, 'audioPath'), false);
  }
});

test('invalid selections and questions without a current episode never start the sole candidate', async () => {
  for (const intent of [{ kind: 'select', episodeId: 'not-in-catalog' }, { kind: 'current' }] satisfies CatalogIntent[]) {
    const result = await service([design], async () => intent).resolve('owner', 'A request', 'missing-current', [], signal());
    assert.equal(result.kind, 'clarify'); assert.equal(result.episode, undefined);
    assert.match(result.message, /Design Fieldwork/);
    assert.doesNotMatch(result.message, /we’re listening|undefined/i);
  }
});

test('ambiguous episodes with the same guest are identified by their distinct titles', async () => {
  const sequel = { ...mars, id: 'orbit-venus', title: 'Mapping Venus' };
  const catalog = service([mars, sequel], async () => ({ kind: 'clarify', candidateIds: [mars.id, sequel.id] }));
  const result = await catalog.resolve('owner', 'Play the Maya Chen interview', undefined, [], signal());
  assert.equal(result.kind, 'clarify');
  assert(result.message.includes(mars.title)); assert(result.message.includes(sequel.title));
});

test('resume uses only saved episodes still available in the catalog and does not pick an arbitrary first result', async () => {
  const resume: CatalogInterpreter = async () => ({ kind: 'resume' });
  const selected = await service([mars, design], resume, design).resolve('owner', 'Continue', undefined, [], signal());
  assert.equal(selected.episode?.id, design.id);
  const removed = { ...design, id: 'removed' };
  const unknown = await service([mars, design], resume, removed).resolve('owner', 'Continue', undefined, [], signal());
  assert.equal(unknown.kind, 'clarify'); assert.equal(unknown.episode, undefined);
});

test('exact current-player controls do not depend on Jev or consume its allowance', async () => {
  const unavailable = async (): Promise<never> => { throw new Error('Provider must not run'); };
  const catalog = new CatalogService({ catalog: async () => [design], unfinished: unavailable, charge: unavailable }, unavailable);
  for (const utterance of ['pause', 'go to 37 minutes', 'skip this ad']) {
    assert.equal((await catalog.resolve('owner', utterance, design.id, [], signal())).kind, 'current');
  }
});

test('failed or cancelled interpretation cannot fall back to the only available episode', async () => {
  const failed = service([mars], async () => { throw new Error('Unavailable'); });
  await assert.rejects(failed.resolve('owner', 'Play a show', undefined, [], signal()), /Unavailable/);
  const controller = new AbortController();
  const cancelled = service([mars], async () => {
    controller.abort(); return { kind: 'select', episodeId: mars.id };
  });
  await assert.rejects(cancelled.resolve('owner', 'Play a show', undefined, [], controller.signal), { name: 'AbortError' });
});

test('the Jev adapter requires both a supported target and a confident episode selection', async () => {
  assert.deepEqual(await interpreter()(context, signal()), { kind: 'select', episodeId: mars.id });
  for (const overrides of [
    { catalogMatch: choice('unavailable') },
    { catalogMatch: choice('available', { available: 0.6, unavailable: 0.4 }) },
    { action: choice('choose', { choose: 0.6, unclear: 0.4 }) },
    { episode: choice('invented-id') },
    { episode: choice(mars.id, { [mars.id]: 0.51, [design.id]: 0.49 }) },
  ]) {
    assert.equal((await interpreter(overrides)(context, signal())).kind, 'clarify');
  }
});

test('Jev candidate arguments are generated from the supplied catalog', async () => {
  let checked = false;
  const choices: typeof askChoices = async <K extends string>(_state: unknown, questions: Record<K, { criteria: Record<string, string> }>) => {
    const all = questions as Record<string, { criteria: Record<string, string> }>;
    assert.deepEqual(Object.keys(all.episode!.criteria).sort(), [mars.id, design.id, 'none'].sort());
    assert(all.episode!.criteria[design.id]!.includes(design.showTitle));
    checked = true;
    return { action: choice('choose'), catalogMatch: choice('available'), episode: choice(design.id) } as Record<K, ChoiceAnswer>;
  };
  const result = await createCatalogInterpreter({ apiKey: 'test-only', model: 'test-only' }, choices)(context, signal());
  assert(checked); assert.deepEqual(result, { kind: 'select', episodeId: design.id });
});
