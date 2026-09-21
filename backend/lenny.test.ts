import assert from 'node:assert/strict';
import test from 'node:test';
import { ContinuousVoiceBudget } from './continuous-voice';
import { parseLennyTranscript, publisherAdBreaks, reviewedAdBreaks } from './lenny-catalog';
import { exactCommand } from './intelligence';

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
test('spoken time skips are bounded and questions are not playback commands', () => {
  assert.equal(exactCommand('Go forward thirty seconds.')?.delta, 30);
  assert.equal(exactCommand('go back two minutes')?.delta, -120);
  assert.equal(exactCommand('skip ahead twenty-five seconds')?.delta, 25);
  assert.equal(exactCommand('go forward eleven minutes'), undefined);
  assert.equal(exactCommand('Why did he go back thirty seconds?'), undefined);
  assert.equal(exactCommand('Go to thirty-seven minutes.')?.position, 2220);
  assert.equal(exactCommand('go to 37:10')?.position, 2230);
  assert.equal(exactCommand('go to 37:90'), undefined);
  assert.equal(exactCommand('Start over')?.position, 0);
  assert.equal(exactCommand('skip the sponsor please')?.kind, 'skip-ad');
  assert.equal(exactCommand('Can you explain why we skip the sponsor?'), undefined);
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
