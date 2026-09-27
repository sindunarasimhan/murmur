import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captionAt } from './playback-captions';

const captions = [{ startSeconds: 2, endSeconds: 5, text: 'First thought.' }, { startSeconds: 7, endSeconds: 9, text: 'Next thought.' }];
test('caption intervals include their start but not their end or gaps', () => {
  assert.equal(captionAt(captions, 2), 'First thought.');
  assert.equal(captionAt(captions, 5), '');
  assert.equal(captionAt(captions, 6), '');
  assert.equal(captionAt(captions, 7), 'Next thought.');
  assert.equal(captionAt(captions, 9), '');
});
test('seeking in either direction selects the actual current segment', () => {
  assert.equal(captionAt(captions, 8), 'Next thought.');
  assert.equal(captionAt(captions, 3), 'First thought.');
  assert.equal(captionAt(captions, 100), '');
});
test('long segments advance in short chunks instead of truncating the same text throughout', () => {
  const long = [{ startSeconds: 0, endSeconds: 10, text: 'one two three four five six seven eight nine ten' }];
  assert.equal(captionAt(long, 0, 20), 'one two three four');
  assert.equal(captionAt(long, 4, 20), 'five six seven eight');
  assert.equal(captionAt(long, 8, 20), 'nine ten');
});
test('empty and invalid timestamps never invent transcript content', () => {
  assert.equal(captionAt([], 0), '');
  assert.equal(captionAt(captions, NaN), '');
  assert.equal(captionAt([{ startSeconds: 0, endSeconds: 1, text: '  ' }], 0), '');
});
