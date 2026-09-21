import { randomUUID } from 'node:crypto';
import { backendConfig } from '../backend/config';
import { createIntelligence } from '../backend/intelligence';
import { preparedManifest } from '../backend/preparation';
import type { ListeningSession } from '../shared/listening';

const config = backendConfig();
if (!config.providers.typesafe.apiKey) throw new Error('TYPESAFE_API_KEY is required for this opt-in live evaluation.');
const intelligence = createIntelligence(config);
const manifest = await preparedManifest();
const cases = [
  { id: 'deictic-explanation', text: 'Go deeper on that', position: 38, kinds: ['deeper'], passage: 'tradeoffs' },
  { id: 'named-passage', text: 'Explain the experiment with the movable chairs', position: 8, kinds: ['explain', 'deeper'], passage: 'experiment' },
  { id: 'return', text: 'Take me back to what I was listening to', position: 38, kinds: ['return'] },
  { id: 'polite-pause', text: 'Could you pause the episode for a moment?', position: 38, kinds: ['pause'] },
  { id: 'not-a-command', text: 'Why would someone pause before rebuilding the park?', position: 55, kinds: ['explain', 'deeper'], passage: 'experiment' },
  { id: 'missing-evidence', text: 'What does this episode say about the winner of the baseball game last night?', position: 55, kinds: ['explain'], passage: null },
];
let failures = 0;
for (const item of cases) {
  const session: ListeningSession = { id: randomUUID(), episodeId: manifest.id, audioVersion: manifest.version, revision: 1, positionSeconds: item.position, bookmarkSeconds: item.position, phase: 'listening', pendingAction: null };
  const start = performance.now();
  const result = await intelligence.decide({ utterance: item.text, session, evidence: manifest.segments, history: [] }, AbortSignal.timeout(5000));
  const correct = item.kinds.includes(result.kind) && (item.passage === undefined || (result.passageId ?? null) === item.passage);
  if (!correct) failures += 1;
  console.log(JSON.stringify({ case: item.id, passed: correct, milliseconds: Math.round(performance.now() - start), kind: result.kind, passage: result.passageId ?? null }));
}
console.log(`${cases.length - failures}/${cases.length} live Jev examples passed. This is a small smoke evaluation, not a production accuracy benchmark.`);
process.exitCode = failures ? 1 : 0;
