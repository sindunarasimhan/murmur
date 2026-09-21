import assert from 'node:assert/strict';
import test from 'node:test';
import { askChoices, parseChoiceAnswer, type ChoiceQuestion } from './client';

const question: ChoiceQuestion = { type: 'choice', instructions: 'Choose an option.', criteria: { a: 'First', b: 'Second' } };
const answer = { type: 'choice', choice: 'a', confidence: 0.8, probabilities: { a: 0.9, b: 0.1 } };

test('Jev adapter rejects invented labels, invalid confidence, incomplete or inconsistent distributions', () => {
  for (const bad of [
    null, [], { ...answer, type: 'noul' }, { ...answer, choice: 'invented' },
    { ...answer, confidence: NaN }, { ...answer, confidence: 1.1 },
    { ...answer, probabilities: { a: 0.9 } }, { ...answer, probabilities: { a: 0.9, b: -0.1 } },
    { ...answer, probabilities: { a: 0.9, b: 0.9 } }, { ...answer, probabilities: { a: 0.1, b: 0.9 } },
    { ...answer, probabilities: { a: 0.9, b: 0.1, c: 0 } },
  ]) assert.throws(() => parseChoiceAnswer(bad, question));
});

test('Jev sends independent questions in one request and requires an answer to each', async () => {
  let calls = 0;
  const result = await askChoices({ question: 'Example' }, { one: question, two: question }, {
    apiKey: 'typesafe-server-secret', model: 'jev-latest', timeoutMs: 1000,
    fetch: async (url, init) => {
      calls += 1;
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer typesafe-server-secret');
      assert.deepEqual(JSON.parse(String(init?.body)).questions, { one: question, two: question });
      return Response.json({ answers: { one: answer, two: answer } });
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.two.choice, 'a');
  await assert.rejects(askChoices({}, { one: question, two: question }, {
    apiKey: 'key', model: 'jev-latest', timeoutMs: 1000,
    fetch: async () => Response.json({ answers: { one: answer } }),
  }));
});
