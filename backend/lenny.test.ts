import assert from 'node:assert/strict';
import test from 'node:test';
import { ContinuousVoiceBudget } from './continuous-voice';
import { parseLennyTranscript, publisherAdBreaks, reviewedAdBreaks } from './lenny-catalog';
import { timeCandidates } from './time-seek';

test('transcript import preserves overlapping speakers, rejects missing timing and mismatched durations', () => {
  const text = '**Host** (00:00:10):\nA question.\n\n**Guest** (00:00:09):\nOverlapping speech.\n\n**Host** (00:00:10):\nClarification.';
  const passages = parseLennyTranscript(text, 20);
  assert.deepEqual(passages.map((p) => [p.startSeconds, p.endSeconds]), [[9, 10], [10, 20]]);
  assert.match(passages[1]!.text, /Clarification/);
  assert.throws(() => parseLennyTranscript(text, 9));
  assert.throws(() => parseLennyTranscript('Untimed transcript.', 20));
});
test('advertising discussion is not an ad; changed transcripts cannot reuse reviewed markers', () => {
  assert.deepEqual(publisherAdBreaks([{ startSeconds: 0, title: 'How advertising works' }, { startSeconds: 40, title: 'Monetization' }], 90), []);
  assert.deepEqual(publisherAdBreaks([{ startSeconds: 0, title: 'Sponsor' }], 90), []);
  assert.deepEqual(publisherAdBreaks([{ startSeconds: 0, title: 'Sponsor' }, { startSeconds: 40, title: 'Interview' }], 90).map((ad) => ad.endSeconds), [40]);
  assert.deepEqual(reviewedAdBreaks('lenny-brian-halligan', 'changed-transcript', []), []);
});
test('spoken time amounts are extracted without deciding playback intent locally', () => {
  assert.equal(timeCandidates('Go forward thirty seconds.')[0]?.seconds, 30);
  assert.equal(timeCandidates('go back two minutes')[0]?.seconds, 120);
  assert.equal(timeCandidates('skip ahead twenty-five seconds')[0]?.seconds, 25);
  assert.equal(timeCandidates('go forward eleven minutes')[0]?.seconds, 660);
  assert.equal(timeCandidates('Why did he go back thirty seconds?')[0]?.seconds, 30);
  assert.equal(timeCandidates('Go to thirty-seven minutes.')[0]?.seconds, 2220);
  assert.equal(timeCandidates('go to 37:10')[0]?.seconds, 2230);
  assert.equal(timeCandidates('go to 37:90').length, 0);
});
test('continuous voice permits repeated bounded PCM turns but no provider controls or audio floods', () => {
  const budget = new ContinuousVoiceBudget(0);
  const append = { type: 'input_audio_buffer.append', audio: Buffer.alloc(4800).toString('base64') };
  budget.accept(append, 100); budget.accept({ type: 'input_audio_buffer.commit' }, 100);
  budget.accept(append, 200); budget.accept({ type: 'input_audio_buffer.commit' }, 200);
  assert.throws(() => budget.accept({ type: 'session.update' }, 300));
  assert.throws(() => budget.accept({ type: 'input_audio_buffer.append', audio: 'AAAA' }, 300));
  assert.throws(() => new ContinuousVoiceBudget(0).accept({ type: append.type, audio: Buffer.alloc(48_000 * 4).toString('base64') }, 1));
  assert.throws(() => new ContinuousVoiceBudget(0).accept({ type: append.type, audio: Buffer.alloc(48_000 * 21).toString('base64') }, 30_000));
});

test('clearing a voice turn drops buffered audio but does not reset cumulative rate limits', () => {
  const budget = new ContinuousVoiceBudget(0);
  const append = { type: 'input_audio_buffer.append', audio: Buffer.alloc(4800).toString('base64') };
  budget.accept(append, 100);
  assert.deepEqual(JSON.parse(budget.accept({ type: 'input_audio_buffer.clear' }, 100)), { type: 'input_audio_buffer.clear' });
  assert.throws(() => budget.accept({ type: 'input_audio_buffer.commit' }, 100));
  budget.accept(append, 200);
  budget.accept({ type: 'input_audio_buffer.commit' }, 200);
  const flooded = new ContinuousVoiceBudget(0);
  for (let i = 0; i < 30; i++) {
    flooded.accept(append, 1);
    flooded.accept({ type: 'input_audio_buffer.clear' }, 1);
  }
  assert.throws(() => flooded.accept(append, 1), /budget/);
});

test('semantic voice accepts extended speech without a client commit and retains rate protection', () => {
  const budget = new ContinuousVoiceBudget(0, true);
  const frame = { type: 'input_audio_buffer.append', audio: Buffer.alloc(4800).toString('base64') };
  for (let i = 0; i < 300; i++) budget.accept(frame, i * 100);
  assert.throws(() => budget.accept({ type: 'input_audio_buffer.commit' }, 30000));
  assert.deepEqual(JSON.parse(budget.accept({ type: 'input_audio_buffer.clear' }, 30000)), { type: 'input_audio_buffer.clear' });
  assert.throws(() => new ContinuousVoiceBudget(0, true).accept({ type: frame.type, audio: Buffer.alloc(48_000 * 4).toString('base64') }, 1));
});
