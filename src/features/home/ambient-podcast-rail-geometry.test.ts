import assert from 'node:assert/strict';
import test from 'node:test';

import {
  railCardCenter,
  railDirectionForRow,
  railFocus,
  railRowSeedOffset,
  railRowSpeed,
  railScale,
  railTranslation,
} from '@/features/home/ambient-podcast-rail-geometry';

test('alternates every artwork row in the opposite direction', () => {
  assert.deepEqual(
    Array.from({ length: 6 }, (_, index) => railDirectionForRow(index)),
    ['right', 'left', 'right', 'left', 'right', 'left'],
  );
});

test('turns the motion input into mild independent row velocities', () => {
  const speeds = Array.from({ length: 6 }, (_, index) => railRowSpeed(14, index));

  assert.ok(Math.abs(speeds[0]! - 3.36) < 1e-9);
  assert.ok(Math.abs(speeds[1]! - 2.7552) < 1e-9);
  assert.ok(new Set(speeds).size > 1);
  assert.ok(speeds.every((speed) => speed < 3.5));
});

test('staggered rows start at distinct item-relative phases', () => {
  const itemSpan = 108;
  const offsets = Array.from(
    { length: 6 },
    (_, index) => railRowSeedOffset(index, itemSpan),
  );

  assert.equal(new Set(offsets).size, 6);
  assert.ok(offsets.every((offset) => offset >= 0 && offset < itemSpan));
  assert.ok(Math.abs(offsets[0]! - 12.96) < 1e-9);
  assert.ok(Math.abs(offsets[1]! - 62.64) < 1e-9);
});

test('moves the podcast rail continuously to the right', () => {
  const cycleWidth = 864;
  const seedOffset = 30;
  const start = railTranslation(0, cycleWidth, seedOffset);
  const afterFourSeconds = railTranslation(0.055, cycleWidth, seedOffset);

  assert.ok(afterFourSeconds > start);
  assert.ok(Math.abs((afterFourSeconds - start) - 47.52) < 1e-9);
});

test('moves an independent background rail continuously to the left', () => {
  const cycleWidth = 864;
  const seedOffset = 30;
  const start = railTranslation(0, cycleWidth, seedOffset, 'left');
  const afterFourSeconds = railTranslation(0.055, cycleWidth, seedOffset, 'left');

  assert.ok(afterFourSeconds < start);
  assert.ok(Math.abs((afterFourSeconds - start) + 47.52) < 1e-9);
});

test('keeps both counter-scrolling rails identical across their loop seams', () => {
  const itemSpan = 108;
  const itemCount = 8;
  const cycleWidth = itemSpan * itemCount;
  const seedOffset = 30;
  const logicalIndex = 2;
  const beforeReset = railCardCenter(
    logicalIndex,
    itemSpan,
    railTranslation(1, cycleWidth, seedOffset),
  );
  const afterReset = railCardCenter(
    logicalIndex + itemCount,
    itemSpan,
    railTranslation(0, cycleWidth, seedOffset),
  );
  const backgroundBeforeReset = railCardCenter(
    logicalIndex + itemCount,
    itemSpan,
    railTranslation(1, cycleWidth, seedOffset, 'left'),
  );
  const backgroundAfterReset = railCardCenter(
    logicalIndex,
    itemSpan,
    railTranslation(0, cycleWidth, seedOffset, 'left'),
  );

  assert.equal(afterReset, beforeReset);
  assert.equal(backgroundAfterReset, backgroundBeforeReset);
});

test('enlarges a cover symmetrically as it approaches screen center', () => {
  const viewportWidth = 390;
  const itemSpan = 108;
  const center = viewportWidth / 2;
  const centerScale = railScale(railFocus(center, viewportWidth, itemSpan));
  const leftScale = railScale(railFocus(center - 100, viewportWidth, itemSpan));
  const rightScale = railScale(railFocus(center + 100, viewportWidth, itemSpan));
  const farScale = railScale(railFocus(-100, viewportWidth, itemSpan));

  assert.equal(centerScale, 1.09);
  assert.equal(leftScale, rightScale);
  assert.ok(centerScale > leftScale);
  assert.ok(leftScale > farScale);
  assert.equal(farScale, 0.91);
});

test('uses an item-sized focus window rather than a viewport-wide one', () => {
  const viewportWidth = 390;
  const center = viewportWidth / 2;
  const itemSpan = 108;

  assert.equal(railFocus(center, viewportWidth, itemSpan), 1);
  assert.ok(railFocus(center + itemSpan, viewportWidth, itemSpan) > 0);
  assert.equal(railFocus(center + itemSpan * 1.45, viewportWidth, itemSpan), 0);
});
