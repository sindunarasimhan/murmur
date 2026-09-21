import assert from 'node:assert/strict';
import type { PreparedEpisode } from '../shared/listening';
import { backendConfig } from '../backend/config';
import { createCatalogInterpreter } from '../backend/catalog-interpreter';
import { CatalogService } from '../backend/catalog-service';
import { askChoices } from '../src/server/typesafe/client';

// Opt-in live Jev evaluation. The catalog is fictional; no database is modified.
const mars: PreparedEpisode = {
  id: 'orbit-mars', title: 'Finding our way to Mars', showTitle: 'Orbit Notes', guest: 'Maya Chen',
  description: 'Navigation and mission planning for deep-space exploration.',
  durationSeconds: 3600, status: 'ready', audioVersion: 'a'.repeat(64), audioPath: '/media/example.mp3', transcriptReady: true,
};
const design: PreparedEpisode = {
  ...mars, id: 'design-fieldwork', title: 'Making public services accessible', showTitle: 'Design Fieldwork',
  guest: 'Inez Costa', description: 'Research and inclusive design for civic services.',
};
type Case = {
  utterance: string;
  kind: 'play' | 'clarify' | 'current' | 'stop' | 'home';
  expectedEpisode?: string;
  catalog?: PreparedEpisode[];
  current?: string;
  unfinished?: PreparedEpisode;
  history?: string[];
};
const cases: Case[] = [
  { utterance: 'Could you put on the Maya Chen interview?', kind: 'play', expectedEpisode: mars.id },
  { utterance: 'Play the one about deep-space navigation', kind: 'play', expectedEpisode: mars.id },
  { utterance: 'I would like to hear Design Fieldwork', kind: 'play', expectedEpisode: design.id },
  { utterance: 'Play Lenny', kind: 'clarify' },
  { utterance: 'Play Brian Halligan', kind: 'clarify' },
  { utterance: 'Play the Daily', kind: 'clarify' },
  { utterance: 'What did she mean by that?', kind: 'current', current: design.id },
  { utterance: 'Resume where I left off', kind: 'play', expectedEpisode: mars.id, unfinished: mars },
  { utterance: 'Play Orbit Notes', kind: 'clarify', catalog: [design] },
  { utterance: 'Could you play Design Fieldwork?', kind: 'play', expectedEpisode: design.id, catalog: [design] },
  { utterance: 'Yes, please', kind: 'play', expectedEpisode: design.id, catalog: [design], history: ['Play a podcast', `I have “${design.title}” from ${design.showTitle}. Would you like to play it?`] },
  { utterance: 'Do not play the Mars episode', kind: 'clarify' },
  { utterance: 'Turn the microphone off', kind: 'stop', current: design.id },
  { utterance: 'Take me back home', kind: 'home', current: design.id },
];
let judgments: unknown;
const interpret = createCatalogInterpreter(backendConfig().providers.typesafe, async (state, questions, options) => {
  const answers = await askChoices(state, questions, options);
  judgments = answers;
  return answers;
});
const filter = process.argv[2]?.toLowerCase();
const selectedCases = filter ? cases.filter((item) => item.utterance.toLowerCase().includes(filter)) : cases;
assert(selectedCases.length, 'No evaluation cases match that filter.');
let failed = 0;
for (const item of selectedCases) {
  const service = new CatalogService({
    catalog: async () => item.catalog ?? [mars, design],
    unfinished: async () => item.unfinished,
    charge: async () => {},
  }, interpret);
  try {
    const result = await service.resolve('evaluation', item.utterance, item.current, item.history ?? [], new AbortController().signal);
    assert.equal(result.kind, item.kind);
    assert.equal(result.episode?.id, item.expectedEpisode);
    console.log(`PASS ${item.utterance} → ${result.kind}${result.episode ? ` (${result.episode.id})` : ''}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${item.utterance}: ${error instanceof Error ? error.message : 'Request failed'}`);
    console.error(JSON.stringify(judgments));
  }
}
console.log(`${selectedCases.length - failed}/${selectedCases.length} live catalog cases passed.`);
if (failed) process.exitCode = 1;
