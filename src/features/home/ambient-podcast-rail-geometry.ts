export const RAIL_MIN_SCALE = 0.91;
export const RAIL_SCALE_BOOST = 0.18;
export const RAIL_FOCUS_RADIUS_IN_SPANS = 1.45;
export const RAIL_ROW_SPEED_SCALE = 0.24;

const ROW_SPEED_VARIANTS = [1, 0.82, 0.93, 0.76, 0.88, 0.8] as const;
const ROW_PHASES = [0.12, 0.58, 0.24, 0.7, 0.36, 0.82] as const;

export type RailDirection = 'left' | 'right';

export function railDirectionForRow(rowIndex: number): RailDirection {
  return Math.abs(Math.trunc(rowIndex)) % 2 === 0 ? 'right' : 'left';
}

export function railRowSpeed(baseSpeed: number, rowIndex: number) {
  const safeBaseSpeed = Number.isFinite(baseSpeed)
    ? Math.max(2, Math.min(24, Math.abs(baseSpeed)))
    : 14;
  const variantIndex = Math.abs(Math.trunc(rowIndex)) % ROW_SPEED_VARIANTS.length;
  const variant = ROW_SPEED_VARIANTS[variantIndex] ?? 1;

  return safeBaseSpeed * RAIL_ROW_SPEED_SCALE * variant;
}

export function railRowSeedOffset(rowIndex: number, itemSpan: number) {
  const phaseIndex = Math.abs(Math.trunc(rowIndex)) % ROW_PHASES.length;
  const phase = ROW_PHASES[phaseIndex] ?? 0;
  return Math.max(0, itemSpan) * phase;
}

export function railTranslation(
  progress: number,
  cycleWidth: number,
  seedOffset: number,
  direction: RailDirection = 'right',
) {
  'worklet';

  if (direction === 'left') {
    return seedOffset - progress * cycleWidth;
  }

  return -cycleWidth + seedOffset + progress * cycleWidth;
}

export function railCardCenter(
  index: number,
  itemSpan: number,
  translation: number,
) {
  'worklet';
  return index * itemSpan + translation;
}

export function railFocus(
  cardCenter: number,
  viewportWidth: number,
  itemSpan: number,
) {
  'worklet';
  const distance = Math.abs(cardCenter - viewportWidth / 2);
  const focusRange = Math.max(1, itemSpan * RAIL_FOCUS_RADIUS_IN_SPANS);
  return Math.max(0, Math.min(1, 1 - distance / focusRange));
}

export function railScale(focus: number) {
  'worklet';
  return RAIL_MIN_SCALE + Math.max(0, Math.min(1, focus)) * RAIL_SCALE_BOOST;
}
