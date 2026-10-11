import assert from 'node:assert/strict';
import test from 'node:test';
import { adAtPosition, adDestination, validatedAdPlan } from '../shared/ad-plan';
import { preprocessAds } from './ad-preprocessing';

const version = 'a'.repeat(64);
const segments = [
  { id: 'intro', startSeconds: 0, endSeconds: 10, text: 'Welcome to the interview.' },
  { id: 'ad1', startSeconds: 10, endSeconds: 20, text: 'This episode is brought to you by Acme.' },
  { id: 'ad2', startSeconds: 20, endSeconds: 30, text: 'Visit Acme for a discount.' },
  { id: 'talk', startSeconds: 30, endSeconds: 60, text: 'How do you run your business?' },
];
test('preprocessing copies source times and merges only adjacent ad passages', async () => {
  const plan = await preprocessAds({ audioVersion: version, durationSeconds: 60, segments }, async (batch) =>
    batch.map((segment) => ({ id: segment.id, classification: segment.id.startsWith('ad') ? 'advertisement' : 'content', probability: 0.99 })));
  assert.equal(plan.status, 'partial');
  assert.equal(plan.timing, 'publisher-passages');
  assert.deepEqual(plan.intervals, [{ id: 'ad-ad1', startSeconds: 10, endSeconds: 30, source: 'transcript-classification', probability: 0.99 }]);
  assert.equal(adAtPosition(plan, 10)?.endSeconds, 30);
  assert.equal(adAtPosition(plan, 30), undefined);
  assert.equal(adDestination({ ...plan, intervals: [{ id: 'a', startSeconds: 10, endSeconds: 20 }, { id: 'b', startSeconds: 20, endSeconds: 30 }] }, 10), 30);
});
test('uncertain and mixed passages are not silently cut out', async () => {
  const plan = await preprocessAds({ audioVersion: version, durationSeconds: 60, segments }, async (batch) =>
    batch.map((segment) => ({ id: segment.id, classification: 'mixed', probability: 0.99 })));
  assert.deepEqual(plan.intervals, []);
  assert.equal(plan.status, 'partial');
});
test('plan validation rejects stale, overlapping, reversed and out-of-duration intervals', () => {
  const plan = { audioVersion: version, revision: 1, status: 'partial', intervals: [{ id: 'a', startSeconds: 10, endSeconds: 30 }] };
  assert(validatedAdPlan(plan, version, 60));
  assert.equal(validatedAdPlan(plan, 'b'.repeat(64), 60), null);
  for (const intervals of [[{ id: 'a', startSeconds: 30, endSeconds: 10 }], [{ id: 'a', startSeconds: 10, endSeconds: 61 }], [...plan.intervals, { id: 'b', startSeconds: 20, endSeconds: 40 }]]) {
    assert.equal(validatedAdPlan({ ...plan, intervals }, version, 60), null);
  }
});
test('malformed transcript never reaches classifier and missing judgments fail preparation', async () => {
  await assert.rejects(preprocessAds({ audioVersion: version, durationSeconds: 60, segments: [...segments].reverse() }, async () => { throw Error('must not run'); }), /transcript/);
  await assert.rejects(preprocessAds({ audioVersion: version, durationSeconds: 60, segments }, async () => []), /judgment/);
});
