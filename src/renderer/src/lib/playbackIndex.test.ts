import assert from "node:assert/strict";
import test from "node:test";
import {
  deathAgeIndexed,
  flashAtIndexed,
  indexDump,
  narrowShotWindow,
  poseAtIndexed,
  shotsInWindowIndexed,
  type PlaybackIndex,
} from "./playbackIndex.ts";
import type { PreviewDump, PreviewFrame, PreviewPose, PreviewShot } from "./clipPlayback.ts";

function pose(partial: Partial<PreviewPose> & { alive?: boolean }): PreviewPose {
  return {
    x: 0,
    y: 0,
    z: 0,
    pitch: 0,
    yaw: 0,
    alive: true,
    ducking: false,
    weapon: "ak47",
    team: "T",
    name: "a",
    health: 100,
    armor: 0,
    duck: 0,
    punchPitch: 0,
    punchYaw: 0,
    punchAge: -1,
    scoped: false,
    walking: false,
    place: "",
    ...partial,
  };
}

function dump(frames: PreviewFrame[], extra: Partial<PreviewDump> = {}): PreviewDump {
  return {
    tickrate: 64,
    map: "de_dust2",
    povSteamid: "p",
    startTick: frames[0]?.tick ?? 0,
    endTick: frames.at(-1)?.tick ?? 0,
    stride: 2,
    frames,
    shots: [],
    grenades: [],
    smokes: [],
    fires: [],
    bursts: [],
    blinds: [],
    mapGltf: null,
    mapSource: "fallback",
    ...extra,
  };
}

function referenceFrame(frames: PreviewFrame[], tick: number) {
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

function referencePose(frames: PreviewFrame[], tick: number, steamid: string) {
  if (!frames.length) return null;
  const i = referenceFrame(frames, tick);
  const cur = frames[i].players[steamid];
  if (!cur) return null;
  const next = frames[i + 1];
  if (!next) return cur;
  const nxt = next.players[steamid];
  if (!nxt) return cur;
  const span = next.tick - frames[i].tick;
  const t = span <= 0 ? 0 : Math.min(1, Math.max(0, (tick - frames[i].tick) / span));
  return { ...cur, x: cur.x + (nxt.x - cur.x) * t };
}

function referenceDeath(frames: PreviewFrame[], tick: number, steamid: string, tickrate: number) {
  const at = referencePose(frames, tick, steamid);
  if (!at || at.alive) return null;
  let lastAlive = -1;
  for (const frame of frames) {
    if (frame.tick > tick) break;
    if (frame.players[steamid]?.alive) lastAlive = frame.tick;
  }
  if (lastAlive < 0) return 10;
  return (tick - lastAlive) / Math.max(tickrate, 1);
}

function referenceShots(shots: PreviewShot[], tick: number, tickrate: number, seconds: number) {
  const span = Math.max(1, seconds * Math.max(tickrate, 1));
  return shots.filter((shot) => shot.tick <= tick && tick - shot.tick <= span);
}

function referenceFlash(
  blinds: { tick: number; steamid: string; duration: number }[],
  tick: number,
  tickrate: number,
  steamid: string,
) {
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

function shot(tick: number, steamid = "p"): PreviewShot {
  return {
    tick,
    steamid,
    weapon: "ak47",
    silenced: false,
    ox: 0,
    oy: 0,
    oz: 0,
    pitch: 0,
    yaw: 0,
    dist: null,
    victim: null,
  };
}

test("death age matches a full scan, including a clip that opens on a corpse", () => {
  const frames: PreviewFrame[] = [
    { tick: 0, players: { p: pose({ alive: false, x: 1 }) } },
    { tick: 4, players: { p: pose({ alive: true, x: 2 }) } },
    { tick: 8, players: { p: pose({ alive: true, x: 3 }) } },
    { tick: 12, players: { p: pose({ alive: false, x: 4 }) } },
    { tick: 16, players: { p: pose({ alive: false, x: 5 }) } },
  ];
  const index = indexDump(dump(frames));
  for (const tick of [0, 3, 8, 12, 15, 20]) {
    assert.equal(deathAgeIndexed(index, tick, "p", 64), referenceDeath(frames, tick, "p", 64), `tick ${tick}`);
  }
});

test("shot windows match a filter and do not alias each other", () => {
  const shots = [shot(10), shot(40), shot(70), shot(100)];
  const index = indexDump(dump([{ tick: 0, players: {} }], { shots }));
  const wide = shotsInWindowIndexed(index, 100, 64, 1);
  const narrow = shotsInWindowIndexed(index, 100, 64, 0.2);
  assert.deepEqual(wide.map((item) => item.tick), referenceShots(shots, 100, 64, 1).map((item) => item.tick));
  assert.deepEqual(
    narrow.map((item) => item.tick),
    referenceShots(shots, 100, 64, 0.2).map((item) => item.tick),
  );
  wide.push(shot(999));
  assert.equal(narrow.some((item) => item.tick === 999), false);
  assert.equal(index.shots.some((item) => item.tick === 999), false);
  const again = narrowShotWindow(wide, 100, 64, 0.2);
  assert.deepEqual(again.map((item) => item.tick), narrow.map((item) => item.tick));
});

test("an unsorted shot list is ordered before the window is taken", () => {
  const shots = [shot(80), shot(10), shot(40)];
  const index = indexDump(dump([{ tick: 0, players: {} }], { shots }));
  const window = shotsInWindowIndexed(index, 50, 64, 2);
  const ordered = [...shots].sort((a, b) => a.tick - b.tick);
  assert.deepEqual(window.map((item) => item.tick), referenceShots(ordered, 50, 64, 2).map((item) => item.tick));
  assert.deepEqual(shots.map((item) => item.tick), [80, 10, 40]);
});

test("flash alpha matches a scan of every blind", () => {
  const blinds = [
    { tick: 0, steamid: "p", duration: 0.5 },
    { tick: 20, steamid: "other", duration: 2 },
    { tick: 30, steamid: "p", duration: 1.5 },
  ];
  const index = indexDump(dump([{ tick: 0, players: {} }], { blinds }));
  for (const tick of [0, 10, 40, 200]) {
    assert.equal(flashAtIndexed(index, tick, 64, "p"), referenceFlash(blinds, tick, 64, "p"), `tick ${tick}`);
  }
});

test("a backward scrub matches the binary-search pose", () => {
  const frames: PreviewFrame[] = [];
  for (let tick = 0; tick <= 40; tick += 2) {
    frames.push({ tick, players: { p: pose({ x: tick }) } });
  }
  const index: PlaybackIndex = indexDump(dump(frames));
  for (let tick = 0; tick <= 40; tick += 1) {
    assert.equal(poseAtIndexed(index, tick, "p")?.x, referencePose(frames, tick, "p")?.x);
  }
  assert.equal(poseAtIndexed(index, 3, "p")?.x, referencePose(frames, 3, "p")?.x);
  assert.equal(poseAtIndexed(index, 0, "p")?.x, 0);
});
