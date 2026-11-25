/**
 * One-time indexes for a pose dump.
 *
 * Playback asks for the same poses and events on every tick. Scanning the whole
 * clip each time makes scrubbing hitch, so this builds sorted event lists and a
 * per-player "last alive" column once. The frame cursor then makes a steady
 * playhead advance in a step or two, and a scrub falls back to binary search.
 *
 * This module imports types only so Node can run its tests without a bundler.
 */

import type {
  PreviewBlind,
  PreviewBomb,
  PreviewDump,
  PreviewEquip,
  PreviewFrame,
  PreviewPlayerEvent,
  PreviewPose,
  PreviewShot,
  PreviewThrow,
} from "./clipPlayback";

export type PlaybackIndex = {
  frames: PreviewFrame[];
  /** Last tick this player was alive at each frame, or -1. Parallel to `frames`. */
  lastAlive: Map<string, number[]>;
  shots: PreviewShot[];
  blinds: Map<string, PreviewBlind[]>;
  reloads: Map<string, PreviewPlayerEvent[]>;
  equips: Map<string, PreviewEquip[]>;
  zooms: Map<string, PreviewPlayerEvent[]>;
  throws: Map<string, PreviewThrow[]>;
  bombs: PreviewBomb[];
  /** Mutated by pose lookups. One index, one owner. */
  frameCursor: number;
};

type Ticked = { tick: number };

function isOrdered(items: Ticked[]) {
  for (let i = 1; i < items.length; i += 1) {
    if (items[i].tick < items[i - 1].tick) return false;
  }
  return true;
}

function sortedByTick<T extends Ticked>(items: T[] | undefined): T[] {
  const list = items ?? [];
  if (list.length < 2 || isOrdered(list)) return list;
  return [...list].sort((a, b) => a.tick - b.tick);
}

function groupByPlayer<T extends { steamid: string }>(items: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const bucket = grouped.get(item.steamid);
    if (bucket) bucket.push(item);
    else grouped.set(item.steamid, [item]);
  }
  return grouped;
}

function lastAliveColumns(frames: PreviewFrame[]) {
  const ids = new Set<string>();
  for (const frame of frames) {
    for (const id of Object.keys(frame.players)) ids.add(id);
  }
  const columns = new Map<string, number[]>();
  for (const id of ids) {
    const column = new Array<number>(frames.length);
    let last = -1;
    for (let i = 0; i < frames.length; i += 1) {
      const at = frames[i].players[id];
      if (at?.alive) last = frames[i].tick;
      column[i] = last;
    }
    columns.set(id, column);
  }
  return columns;
}

export function indexDump(dump: PreviewDump): PlaybackIndex {
  const frames = dump.frames ?? [];
  return {
    frames,
    lastAlive: lastAliveColumns(frames),
    shots: sortedByTick(dump.shots),
    blinds: groupByPlayer(sortedByTick(dump.blinds)),
    reloads: groupByPlayer(sortedByTick(dump.reloads)),
    equips: groupByPlayer(sortedByTick(dump.equips)),
    zooms: groupByPlayer(sortedByTick(dump.zooms)),
    throws: groupByPlayer(sortedByTick(dump.throws)),
    bombs: sortedByTick(dump.bombs),
    frameCursor: 0,
  };
}

/** Last index whose tick is <= `tick`, or -1. */
export function lastAtOrBefore<T extends Ticked>(items: T[], tick: number) {
  let lo = 0;
  let hi = items.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].tick <= tick) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function binaryFrame(frames: PreviewFrame[], tick: number) {
  if (!frames.length) return 0;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (frames[mid].tick <= tick) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Frame under the playhead.
 *
 * A cursor that is already close walks a few frames. Anything further away,
 * including a backward scrub, uses binary search so the result stays exact.
 */
export function frameIndexAtIndexed(index: PlaybackIndex, tick: number) {
  const frames = index.frames;
  const count = frames.length;
  if (!count) return 0;
  let cursor = index.frameCursor;
  if (cursor < 0 || cursor >= count) cursor = 0;
  let next = cursor;
  if (frames[cursor].tick <= tick) {
    while (next + 1 < count && frames[next + 1].tick <= tick) {
      next += 1;
      if (next - cursor > 8) {
        next = binaryFrame(frames, tick);
        break;
      }
    }
  } else {
    while (next > 0 && frames[next].tick > tick) {
      next -= 1;
      if (cursor - next > 8) {
        next = binaryFrame(frames, tick);
        break;
      }
    }
  }
  index.frameCursor = next;
  return next;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function lerpAngle(a: number, b: number, t: number) {
  const delta = ((b - a + 540) % 360) - 180;
  return a + delta * t;
}

export function poseAtIndexed(index: PlaybackIndex, tick: number, steamid: string): PreviewPose | null {
  const frames = index.frames;
  if (!frames.length) return null;
  const i = frameIndexAtIndexed(index, tick);
  const cur = frames[i].players[steamid];
  if (!cur) return null;
  const next = frames[i + 1];
  if (!next) return cur;
  const nxt = next.players[steamid];
  if (!nxt) return cur;
  const span = next.tick - frames[i].tick;
  const t = span <= 0 ? 0 : Math.min(1, Math.max(0, (tick - frames[i].tick) / span));
  return {
    ...cur,
    x: lerp(cur.x, nxt.x, t),
    y: lerp(cur.y, nxt.y, t),
    z: lerp(cur.z, nxt.z, t),
    pitch: lerpAngle(cur.pitch, nxt.pitch, t),
    yaw: lerpAngle(cur.yaw, nxt.yaw, t),
    duck: lerp(cur.duck ?? 0, nxt.duck ?? 0, t),
    punchAge: cur.punchAge < 0 ? -1 : cur.punchAge + (tick - frames[i].tick),
  };
}

export function velocityAtIndexed(index: PlaybackIndex, tick: number, steamid: string, tickrate: number) {
  const frames = index.frames;
  if (frames.length < 2) return { x: 0, y: 0, speed: 0 };
  const i = frameIndexAtIndexed(index, tick);
  const a = frames[Math.max(0, i - 1)];
  const b = frames[Math.min(frames.length - 1, i + 1)];
  const pa = a.players[steamid];
  const pb = b.players[steamid];
  if (!pa || !pb) return { x: 0, y: 0, speed: 0 };
  const seconds = (b.tick - a.tick) / Math.max(tickrate, 1);
  if (seconds <= 0) return { x: 0, y: 0, speed: 0 };
  const x = (pb.x - pa.x) / seconds;
  const y = (pb.y - pa.y) / seconds;
  return { x, y, speed: Math.hypot(x, y) };
}

export function deathAgeIndexed(
  index: PlaybackIndex,
  tick: number,
  steamid: string,
  tickrate: number,
): number | null {
  const pose = poseAtIndexed(index, tick, steamid);
  if (!pose || pose.alive) return null;
  const at = index.lastAlive.get(steamid);
  const last = at ? at[index.frameCursor] : -1;
  if (last == null || last < 0) return 10;
  return (tick - last) / Math.max(tickrate, 1);
}

/** Shots with `tick - span <= shot.tick <= tick`, oldest first. A fresh array. */
export function shotsInWindowIndexed(
  index: PlaybackIndex,
  tick: number,
  tickrate: number,
  seconds: number,
): PreviewShot[] {
  return narrowShotWindow(index.shots, tick, tickrate, seconds);
}

/** Narrow an already-windowed, tick-sorted shot list. Does not alias `shots`. */
export function narrowShotWindow(
  shots: PreviewShot[],
  tick: number,
  tickrate: number,
  seconds: number,
): PreviewShot[] {
  if (!shots.length) return [];
  const span = Math.max(1, seconds * Math.max(tickrate, 1));
  const hi = lastAtOrBefore(shots, tick);
  if (hi < 0) return [];
  const minTick = tick - span;
  let lo = 0;
  let end = hi;
  while (lo < end) {
    const mid = (lo + end) >> 1;
    if (shots[mid].tick < minTick) lo = mid + 1;
    else end = mid;
  }
  if (lo > hi) return [];
  return shots.slice(lo, hi + 1);
}

export function flashAtIndexed(
  index: PlaybackIndex,
  tick: number,
  tickrate: number,
  steamid: string,
) {
  const blinds = index.blinds.get(steamid);
  if (!blinds?.length) return 0;
  const rate = Math.max(tickrate, 1);
  const hi = lastAtOrBefore(blinds, tick);
  let alpha = 0;
  for (let i = 0; i <= hi; i += 1) {
    const blind = blinds[i];
    if (blind.duration <= 0) continue;
    const frac = (tick - blind.tick) / rate / blind.duration;
    if (frac >= 1) continue;
    const value = frac < 0.2 ? 1 : Math.pow(1 - (frac - 0.2) / 0.8, 1.5);
    if (value > alpha) alpha = value;
  }
  return alpha;
}

export function reloadProgressIndexed(
  index: PlaybackIndex,
  tick: number,
  tickrate: number,
  steamid: string,
  seconds: number,
) {
  if (seconds <= 0) return null;
  const reloads = index.reloads.get(steamid);
  if (!reloads?.length) return null;
  const span = seconds * Math.max(tickrate, 1);
  const hi = lastAtOrBefore(reloads, tick);
  for (let i = hi; i >= 0; i -= 1) {
    const frac = (tick - reloads[i].tick) / span;
    if (frac < 1) return frac;
  }
  return null;
}

export function lastEquipIndexed(index: PlaybackIndex, tick: number, steamid: string): PreviewEquip | null {
  const equips = index.equips.get(steamid);
  if (!equips?.length) return null;
  const hi = lastAtOrBefore(equips, tick);
  return hi < 0 ? null : equips[hi];
}

export function zoomAgeIndexed(index: PlaybackIndex, tick: number, tickrate: number, steamid: string) {
  const zooms = index.zooms.get(steamid);
  if (!zooms?.length) return null;
  const hi = lastAtOrBefore(zooms, tick);
  if (hi < 0) return null;
  return (tick - zooms[hi].tick) / Math.max(tickrate, 1);
}

export function throwAgeIndexed(index: PlaybackIndex, tick: number, tickrate: number, steamid: string) {
  const events = index.throws.get(steamid);
  if (!events?.length) return null;
  const hi = lastAtOrBefore(events, tick);
  if (hi < 0) return null;
  return (tick - events[hi].tick) / Math.max(tickrate, 1);
}

export function bombAtIndexed(index: PlaybackIndex, tick: number): PreviewBomb | null {
  const bombs = index.bombs;
  if (!bombs.length) return null;
  const hi = lastAtOrBefore(bombs, tick);
  for (let i = hi; i >= 0; i -= 1) {
    const bomb = bombs[i];
    if (bomb.endTick != null && tick >= bomb.endTick) continue;
    return bomb;
  }
  return null;
}

/** Items with `tick - spanTicks <= item.tick <= tick`. `items` must be tick-sorted. */
export function ticksInWindow<T extends Ticked>(items: T[], tick: number, spanTicks: number): T[] {
  if (!items.length) return [];
  const hi = lastAtOrBefore(items, tick);
  if (hi < 0) return [];
  const minTick = tick - spanTicks;
  let lo = 0;
  let end = hi;
  while (lo < end) {
    const mid = (lo + end) >> 1;
    if (items[mid].tick < minTick) lo = mid + 1;
    else end = mid;
  }
  if (lo > hi) return [];
  return items.slice(lo, hi + 1);
}
