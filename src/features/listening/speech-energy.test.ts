import assert from 'node:assert/strict';
import test from 'node:test';
import { speechEnergy } from './speech-energy';

test('silence and missing samples keep the mouth relaxed', () => {
  assert.equal(speechEnergy([]), 0);
  assert.equal(speechEnergy([{ frames: [0, 0, 0] }]), 0);
  assert.equal(speechEnergy([{ frames: [NaN] }]), 0);
});
test('speech amplitude maps to bounded mouth movement', () => {
  assert.equal(speechEnergy([{ frames: [0.125] }]), 0.5);
  assert.equal(speechEnergy([{ frames: [-1] }]), 1);
});
