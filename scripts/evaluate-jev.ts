import { getServerConfig, SERVER_BUDGETS } from '../src/server/config';
import { EXPLORE_QUESTIONS, selectExploreRoute } from '../src/server/exploration/decision-policy';
import type { ExploreRequest } from '../src/server/exploration/explore-contract';
import { askChoices } from '../src/server/typesafe/client';
import { UpstreamError } from '../src/server/http/upstream';

// Synthetic, labeled examples. No listener recordings or private history are sent.
const cases = [
  { id: 'definition', question: 'What does handoff mean here?', intent: 'clarify', effort: 'simple' },
  { id: 'paraphrase', question: 'Explain that sentence in simpler words.', intent: 'clarify', effort: 'simple' },
  { id: 'arithmetic', question: 'If the team saves 15 minutes on each of 8 handoffs, how many hours does it save?', intent: 'quantitative', effort: 'substantial' },
  { id: 'percentage', question: 'How much of a percentage improvement is going from 20 minutes to 15?', intent: 'quantitative', effort: 'substantial' },
  { id: 'verification', question: 'Is there published research that proves handoff checklists reduce errors?', intent: 'factual', effort: 'substantial' },
  { id: 'objection', question: 'What is the strongest counterargument to requiring a checklist for every handoff?', intent: 'debate', effort: 'substantial' },
  { id: 'tradeoff', question: 'Challenge the claim that handoff checklists always improve teamwork.', intent: 'debate', effort: 'substantial' },
  { id: 'implications', question: 'How might this principle apply to a society with no permanent institutions?', intent: 'abstract', effort: 'substantial' },
] as const;

async function main() {
  const config = getServerConfig();
  if (!config.typesafe.apiKey) throw new Error('Set TYPESAFE_API_KEY in .env.local before running the evaluation.');
  let passed = 0;
  for (const sample of cases) {
    const input: ExploreRequest = {
      question: sample.question, intent: 'clarify', episode: { title: 'Teamwork', showTitle: 'Murmur evaluation' },
      playbackPositionSeconds: 25,
      transcriptContext: '[0:20–0:30; timed cue] A handoff transfers responsibility to another person. A checklist can help that person know what still needs doing.',
    };
    const start = Date.now();
    try {
      const answers = await askChoices({
        question: input.question, episode: input.episode, excerpt: input.transcriptContext, previousTurns: [],
      }, EXPLORE_QUESTIONS, {
        apiKey: config.typesafe.apiKey, model: config.typesafe.model, timeoutMs: SERVER_BUDGETS.decision,
      });
      const route = selectExploreRoute(input, answers);
      const correct = answers.intent.choice === sample.intent && answers.effort.choice === sample.effort;
      if (correct) passed += 1;
      console.log(JSON.stringify({ case: sample.id, correct, intent: answers.intent.choice, effort: answers.effort.choice,
        route: route.source, fastEligible: route.simple, elapsedMs: Date.now() - start }));
    } catch (error) {
      console.log(JSON.stringify({ case: sample.id, correct: false, failure: error instanceof UpstreamError ? error.kind : 'invalid', elapsedMs: Date.now() - start }));
    }
  }
  console.log(`Jev synthetic evaluation: ${passed}/${cases.length} label pairs matched. This is a smoke evaluation, not a calibrated accuracy estimate.`);
  if (passed !== cases.length) process.exitCode = 1;
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Evaluation failed.');
  process.exitCode = 1;
});
