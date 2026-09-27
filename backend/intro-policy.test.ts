import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveIntro } from './intro-policy';

const version = 'a'.repeat(64);
const marker = { endSeconds: 245.3, audioVersion: version, source: 'audio-alignment' };
test('intro skips land at the verified boundary and never jump backward', () => {
  for (const position of [0, 120, 245.29]) assert.deepEqual(resolveIntro(position, 4477, version, marker, `${version}.mp3`), { kind: 'skip', endSeconds: 245.3 });
  for (const position of [245.3, 246, 4477]) assert.deepEqual(resolveIntro(position, 4477, version, marker, `${version}.mp3`), { kind: 'past-intro' });
});
test('missing, changed, out-of-range or unverified intro markers never authorize a seek', () => {
  for (const invalid of [null, {}, { ...marker, audioVersion: 'b'.repeat(64) }, { ...marker, endSeconds: 4477 }, { ...marker, endSeconds: -1 }, { ...marker, source: 'guess' }]) {
    assert.equal(resolveIntro(10, 4477, version, invalid, `${version}.mp3`).kind, 'unverified');
  }
  for (const position of [NaN, -1, 5000]) assert.equal(resolveIntro(position, 4477, version, marker, `${version}.mp3`).kind, 'unverified');
  assert.equal(resolveIntro(10, 4477, version, marker, null).kind, 'unverified');
});
