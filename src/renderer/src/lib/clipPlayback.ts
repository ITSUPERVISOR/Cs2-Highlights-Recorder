import { nadeFlightKind } from "./weaponTable";

export type PreviewPose = {
  x: number;
  y: number;
  z: number;
  pitch: number;
  yaw: number;
  alive: boolean;
  ducking: boolean;
  weapon: string;
  team: string;
  name: string;
  health: number;
  armor: number;
  /** Crouch amount 0..1, so the eye height eases instead of popping. */
  duck: number;
  punchPitch: number;
  punchYaw: number;
  /**
   * Ticks since the view punch latched, or -1 when nothing has been fired.
   *
   * The demo holds the punch value indefinitely after a shot, so the age is what
   * makes it usable: without decaying by it the camera keeps a permanent offset.
   */
  punchAge: number;
    scoped: boolean;
    walking: boolean;
    /** Callout name, e.g. "Banana". */
    place: string;
    /** Paint kit display/internal name from the demo, when present. */
    skin?: string;
    /** Fallback paint kit id. 0 / omitted is vanilla. */
    paintKit?: number;
};

export type PreviewFrame = {
  tick: number;
  players: Record<string, PreviewPose>;
};

/** One bullet, with geometry exact to the shot rather than to the pose sampling. */
export type PreviewShot = {
  tick: number;
  steamid: string;
  weapon: string;
  silenced: boolean;
  ox: number;
  oy: number;
  oz: number;
  pitch: number;
  yaw: number;
  /** How far the bullet travelled, when it hit someone. */
  dist: number | null;
  victim: string | null;
  /** HP dealt, when `bullet_damage` / `player_hurt` recorded it. Optional on old dumps. */
  damage?: number | null;
};

export type PreviewNade = {
  id: number;
  kind: string;
  points: { tick: number; x: number; y: number; z: number }[];
};

/** A smoke or a fire, active between `tick` and `endTick`. */
export type PreviewVolume = {
  id: number | null;
  tick: number;
  endTick: number | null;
  x: number;
  y: number;
  z: number;
};

export type PreviewBurst = {
  kind: string;
  tick: number;
  x: number;
  y: number;
  z: number;
};

/** How long one player was blinded for, from `player_blind`. */
export type PreviewBlind = {
  tick: number;
  steamid: string;
  duration: number;
};

/** A `weapon_reload` or `weapon_zoom`: a tick and who it happened to. */
export type PreviewPlayerEvent = {
  tick: number;
  steamid: string;
};

/** An `item_equip`, carrying which weapon was drawn. */
export type PreviewEquip = PreviewPlayerEvent & {
  item?: string;
  issilenced?: boolean;
};

/** A grenade `weapon_fire`. Not a shot — no tracer. */
export type PreviewThrow = PreviewPlayerEvent & {
  weapon?: string;
};

/** C4 on the ground or planted on a site. */
export type PreviewBomb = {
  kind: "dropped" | "planted";
  tick: number;
  endTick: number | null;
  x: number;
  y: number;
  z: number;
};

export type PreviewDump = {
  tickrate: number;
  map: string;
  povSteamid: string;
  startTick: number;
  endTick: number;
  stride: number;
  frames: PreviewFrame[];
  shots: PreviewShot[];
  grenades: PreviewNade[];
  smokes: PreviewVolume[];
  fires: PreviewVolume[];
  bursts: PreviewBurst[];
  blinds: PreviewBlind[];
  /** Optional: absent when replaying a dump cached before schema 3. */
  reloads?: PreviewPlayerEvent[];
  equips?: PreviewEquip[];
  zooms?: PreviewPlayerEvent[];
/** Optional: absent when replaying a dump cached before throws existed. */
  throws?: PreviewThrow[];
  /** World C4 while dropped or planted. Optional on dumps cached before schema 5. */
  bombs?: PreviewBomb[];
  mapGltf: string | null;
  mapSource: string;
  /** False when the local CS2 install has no VPK for this map. Optional on old dumps. */
  mapInstalled?: boolean;
  /** Radar overlay for medium quality. Absent on low / high / old dumps. */
  radar?: {
    image: string;
    lower?: string | null;
    posX: number;
    posY: number;
    scale: number;
    altitudeSplit?: number | null;
  } | null;
  /** Why a higher quality tier fell back, e.g. `high failed, using medium`. */
  mapError?: string | null;
};

export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export function lerpAngle(a: number, b: number, t: number) {
  let delta = ((b - a + 540) % 360) - 180;
  return a + delta * t;
}

export function frameIndexAt(frames: PreviewFrame[], tick: number) {
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

export function poseAt(frames: PreviewFrame[], tick: number, steamid: string): PreviewPose | null {
  if (!frames.length) return null;
  const i = frameIndexAt(frames, tick);
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
    // Age advances with the playhead, not in stride-sized steps, so the recoil
    // decay is smooth between sampled frames.
    punchAge: cur.punchAge < 0 ? -1 : cur.punchAge + (tick - frames[i].tick),
  };
}

export function cs2ToThree(x: number, y: number, z: number) {
  return { x, y: z, z: -y };
}

/**
 * Horizontal speed in units per second.
 *
 * The dump carries no velocity, so it is differenced across the surrounding
 * frames. Vertical motion is ignored: falling should not read as running.
 */
export function velocityAt(frames: PreviewFrame[], tick: number, steamid: string, tickrate: number) {
  if (frames.length < 2) return { x: 0, y: 0, speed: 0 };
  const i = frameIndexAt(frames, tick);
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

export function speedAt(frames: PreviewFrame[], tick: number, steamid: string, tickrate: number) {
  return velocityAt(frames, tick, steamid, tickrate).speed;
}

/**
 * Seconds since this player last stood alive, or null while they are alive.
 *
 * Playhead-pure so scrubbing shows the fall at the right pose. A clip that
 * opens on a corpse returns a large age so they start fully prone.
 */
export function deathAge(
  frames: PreviewFrame[],
  tick: number,
  steamid: string,
  tickrate: number,
): number | null {
  if (!frames.length) return null;
  const pose = poseAt(frames, tick, steamid);
  if (!pose || pose.alive) return null;
  let lastAlive = -1;
  for (const frame of frames) {
    if (frame.tick > tick) break;
    const at = frame.players[steamid];
    if (at?.alive) lastAlive = frame.tick;
  }
  if (lastAlive < 0) return 10;
  return (tick - lastAlive) / Math.max(tickrate, 1);
}

/** Clip-seconds a view punch takes to settle back to the true aim. */
const PUNCH_LIFE = 0.25;

/**
 * The recoil kick still in effect, decayed from the impulse age.
 *
 * The demo latches the punch value at the shot and holds it, so decaying by age
 * is what keeps this from becoming a permanent aim offset.
 */
export function punchAt(pose: PreviewPose, tickrate: number) {
  const age = pose.punchAge;
  if (age === undefined || age < 0) return { pitch: 0, yaw: 0 };
  const t = age / Math.max(tickrate, 1) / PUNCH_LIFE;
  if (t >= 1) return { pitch: 0, yaw: 0 };
  const k = (1 - t) * (1 - t);
  return { pitch: (pose.punchPitch ?? 0) * k, yaw: (pose.punchYaw ?? 0) * k };
}

/**
 * Screen whiteout for one player, 0 to 1.
 *
 * Holds near full for the first fifth of the blind and then falls away, which is
 * roughly how CS plays it: a flash you can see through immediately never really
 * blinded you.
 */
export function flashAt(
  blinds: PreviewBlind[],
  tick: number,
  tickrate: number,
  steamid: string,
) {
  if (!blinds?.length) return 0;
  const rate = Math.max(tickrate, 1);
  let alpha = 0;
  for (const blind of blinds) {
    if (blind.steamid !== steamid || blind.tick > tick || blind.duration <= 0) continue;
    const frac = (tick - blind.tick) / rate / blind.duration;
    if (frac >= 1) continue;
    const value = frac < 0.2 ? 1 : Math.pow(1 - (frac - 0.2) / 0.8, 1.5);
    if (value > alpha) alpha = value;
  }
  return alpha;
}

/** Shots fired in the last `seconds` of clip time, oldest first. */
export function shotsInWindow(
  shots: PreviewShot[],
  tick: number,
  tickrate: number,
  seconds: number,
) {
  if (!shots?.length) return [];
  const span = Math.max(1, seconds * Math.max(tickrate, 1));
  return shots.filter((shot) => shot.tick <= tick && tick - shot.tick <= span);
}

/**
 * Progress 0..1 through a reload, or null when not reloading.
 *
 * `seconds` comes from the weapon model's own reload clip, which is real motion
 * (the AK's runs 2.433s), so the hands and the magazine stay in step.
 */
export function reloadProgress(
  reloads: PreviewPlayerEvent[] | undefined,
  tick: number,
  tickrate: number,
  steamid: string,
  seconds: number,
) {
  if (!reloads?.length || seconds <= 0) return null;
  const span = seconds * Math.max(tickrate, 1);
  let best: number | null = null;
  for (const reload of reloads) {
    if (reload.steamid !== steamid || reload.tick > tick) continue;
    const frac = (tick - reload.tick) / span;
    if (frac >= 1) continue;
    // The most recent reload wins if two somehow overlap.
    if (best === null || frac < best) best = frac;
  }
  return best;
}

/** The most recent equip at or before `tick`, for the draw animation. */
export function lastEquip(
  equips: PreviewEquip[] | undefined,
  tick: number,
  steamid: string,
): PreviewEquip | null {
  if (!equips?.length) return null;
  let found: PreviewEquip | null = null;
  for (const equip of equips) {
    if (equip.steamid !== steamid || equip.tick > tick) continue;
    if (!found || equip.tick >= found.tick) found = equip;
  }
  return found;
}

/** Clip-seconds since this player last toggled zoom, or null. */
export function zoomAge(
  zooms: PreviewPlayerEvent[] | undefined,
  tick: number,
  tickrate: number,
  steamid: string,
) {
  if (!zooms?.length) return null;
  let latest: number | null = null;
  for (const zoom of zooms) {
    if (zoom.steamid !== steamid || zoom.tick > tick) continue;
    if (latest === null || zoom.tick > latest) latest = zoom.tick;
  }
  if (latest === null) return null;
  return (tick - latest) / Math.max(tickrate, 1);
}

/** Clip-seconds since this player last threw a grenade, or null. */
export function throwAge(
  throws: PreviewThrow[] | undefined,
  tick: number,
  tickrate: number,
  steamid: string,
) {
  if (!throws?.length) return null;
  let latest: number | null = null;
  for (const event of throws) {
    if (event.steamid !== steamid || event.tick > tick) continue;
    if (latest === null || event.tick > latest) latest = event.tick;
  }
  if (latest === null) return null;
  return (tick - latest) / Math.max(tickrate, 1);
}

/**
 * Fallback throw time from a cached dump that has no `throws` array.
 *
 * Uses the first sample of an in-flight grenade whose kind matches the equipped
 * nade. Fine for a solo throw; two of the same nade in one clip can collide.
 */
export function throwAgeFromGrenades(
  grenades: PreviewNade[] | undefined,
  tick: number,
  tickrate: number,
  weapon: string,
) {
  const kind = nadeFlightKind(weapon);
  if (!kind || !grenades?.length) return null;
  let latest: number | null = null;
  for (const nade of grenades) {
    if (nade.kind !== kind) continue;
    const t0 = nade.points[0]?.tick;
    if (t0 == null || t0 > tick) continue;
    if (latest === null || t0 > latest) latest = t0;
  }
  if (latest === null) return null;
  return (tick - latest) / Math.max(tickrate, 1);
}

/** The C4 visible at this tick, or null while it is in someone's inventory. */
export function bombAt(bombs: PreviewBomb[] | undefined, tick: number): PreviewBomb | null {
  if (!bombs?.length) return null;
  let found: PreviewBomb | null = null;
  for (const bomb of bombs) {
    if (tick < bomb.tick) continue;
    if (bomb.endTick != null && tick >= bomb.endTick) continue;
    found = bomb;
  }
  return found;
}

/** How far through its life a volume is at `tick`, or null when it is not active. */
export function volumePhase(
  volume: { tick: number; endTick: number | null },
  tick: number,
  tickrate: number,
  fallbackSeconds: number,
) {
  if (tick < volume.tick) return null;
  const end = volume.endTick ?? volume.tick + fallbackSeconds * Math.max(tickrate, 1);
  if (tick > end) return null;
  const span = Math.max(1, end - volume.tick);
  return Math.min(1, Math.max(0, (tick - volume.tick) / span));
}
