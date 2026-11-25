/** The clip window Preview asks the demo for. Queue warming must use the same ticks. */

export type ClipTicks = {
  firstTick: number;
  lastTick: number;
};

export function previewWindow(moment: ClipTicks, tickrate: number): { start: number; end: number } | null {
  const rate = Number.isFinite(tickrate) && tickrate > 0 ? tickrate : 64;
  const start = Math.max(96, Math.floor(moment.firstTick - 4 * rate));
  const end = Math.floor(moment.lastTick + 3 * rate);
  if (!(end > start)) return null;
  return { start, end };
}
