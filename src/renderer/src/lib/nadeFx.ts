import * as THREE from "three";
import {
  cs2ToThree,
  volumePhase,
  type PreviewBurst,
  type PreviewNade,
  type PreviewVolume,
} from "./clipPlayback";

/**
 * Grenades in flight, smoke clouds, molotov fires and detonation bursts.
 *
 * Everything is pooled and everything is a pure function of the current tick, so
 * scrubbing shows the state that belongs to that moment rather than replaying an
 * animation from wherever it happened to be.
 */

const MAX_NADES = 8;
const TRAIL = 5;
const MAX_SMOKES = 6;
const PUFFS = 22;
const MAX_FIRES = 6;
const FLAMES = 14;
const MAX_BURSTS = 4;

/** Fallback lifetimes for volumes whose expiry event fell outside the demo window. */
const SMOKE_SECONDS = 18;
const FIRE_SECONDS = 7;
const BURST_SECONDS = 0.45;

/** A CS smoke fills roughly this radius. */
const SMOKE_RADIUS = 175;
const FIRE_RADIUS = 110;

const SMOKE_COLOR = 0x6a7080;
const FIRE_CORE = 0xffe066;
const FIRE_RIM = 0xff6a1a;

const NADE_COLOR: Record<string, number> = {
  flash: 0xd8d4c4,
  smoke: 0x8a8e9a,
  molotov: 0xc45c26,
  he: 0x6b8f3a,
  decoy: 0x9aa0a8,
};

export type NadeFx = {
  group: THREE.Group;
  nades: { mesh: THREE.Mesh; trail: THREE.Sprite[] }[];
  smokes: { puffs: THREE.Sprite[]; core: THREE.Mesh }[];
  fires: { flames: THREE.Sprite[]; pool: THREE.Mesh }[];
  bursts: THREE.Sprite[];
  shared: {
    sphere: THREE.SphereGeometry;
    core: THREE.SphereGeometry;
    disc: THREE.CircleGeometry;
    soft: THREE.Texture;
    materials: THREE.Material[];
  };
};

/** Neutral white blob, tinted per use through the material colour. */
function makeSoftTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const half = size / 2;
    const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
    gradient.addColorStop(0, "rgba(255,255,255,0.95)");
    gradient.addColorStop(0.5, "rgba(255,255,255,0.45)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  return new THREE.CanvasTexture(canvas);
}

/**
 * Deterministic offsets for a cluster.
 *
 * Seeded by the volume's own id so a smoke keeps the same shape every frame and
 * across scrubs, instead of boiling.
 */
function clusterOffset(seed: number, i: number) {
  const a = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
  const b = Math.sin(seed * 39.3468 + i * 11.135) * 24634.6345;
  const c = Math.sin(seed * 93.9898 + i * 27.161) * 13875.1234;
  return {
    x: (a - Math.floor(a)) * 2 - 1,
    y: (b - Math.floor(b)) * 2 - 1,
    z: (c - Math.floor(c)) * 2 - 1,
  };
}

/** Ramp up, hold, then fall away. */
function envelope(phase: number, rise: number, fall: number) {
  if (phase < rise) return phase / rise;
  if (phase > 1 - fall) return Math.max(0, (1 - phase) / fall);
  return 1;
}

function sprite(
  texture: THREE.Texture,
  color: number,
  blending: THREE.Blending,
  store: THREE.Material[],
) {
  const material = new THREE.SpriteMaterial({
    map: texture,
    color,
    transparent: true,
    opacity: 0,
    blending,
    depthWrite: false,
  });
  store.push(material);
  const item = new THREE.Sprite(material);
  item.visible = false;
  return item;
}

export function makeNadeFx(): NadeFx {
  const group = new THREE.Group();
  group.name = "nadeFx";
  const soft = makeSoftTexture();
  const sphere = new THREE.SphereGeometry(3.4, 10, 8);
  const core = new THREE.SphereGeometry(1, 12, 10);
  const disc = new THREE.CircleGeometry(1, 20);
  const materials: THREE.Material[] = [];

  const nades: NadeFx["nades"] = [];
  for (let i = 0; i < MAX_NADES; i += 1) {
    const material = new THREE.MeshLambertMaterial({ color: 0x6b8f3a });
    materials.push(material);
    const mesh = new THREE.Mesh(sphere, material);
    mesh.visible = false;
    group.add(mesh);
    const trail: THREE.Sprite[] = [];
    for (let t = 0; t < TRAIL; t += 1) {
      const puff = sprite(soft, 0xffffff, THREE.NormalBlending, materials);
      trail.push(puff);
      group.add(puff);
    }
    nades.push({ mesh, trail });
  }

  const smokes: NadeFx["smokes"] = [];
  for (let i = 0; i < MAX_SMOKES; i += 1) {
    const puffs: THREE.Sprite[] = [];
    for (let p = 0; p < PUFFS; p += 1) {
      const puff = sprite(soft, SMOKE_COLOR, THREE.NormalBlending, materials);
      puffs.push(puff);
      group.add(puff);
    }
    const volume = new THREE.MeshLambertMaterial({
      color: SMOKE_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: true,
    });
    materials.push(volume);
    const coreMesh = new THREE.Mesh(core, volume);
    coreMesh.visible = false;
    group.add(coreMesh);
    smokes.push({ puffs, core: coreMesh });
  }

  const fires: NadeFx["fires"] = [];
  for (let i = 0; i < MAX_FIRES; i += 1) {
    const flames: THREE.Sprite[] = [];
    for (let f = 0; f < FLAMES; f += 1) {
      const color = f % 2 === 0 ? FIRE_CORE : FIRE_RIM;
      const flame = sprite(soft, color, THREE.AdditiveBlending, materials);
      flames.push(flame);
      group.add(flame);
    }
    const poolMat = new THREE.MeshBasicMaterial({
      color: FIRE_RIM,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    materials.push(poolMat);
    const pool = new THREE.Mesh(disc, poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.visible = false;
    group.add(pool);
    fires.push({ flames, pool });
  }

  const bursts: THREE.Sprite[] = [];
  for (let i = 0; i < MAX_BURSTS; i += 1) {
    const burst = sprite(soft, 0xffffff, THREE.AdditiveBlending, materials);
    bursts.push(burst);
    group.add(burst);
  }

  return { group, nades, smokes, fires, bursts, shared: { sphere, core, disc, soft, materials } };
}

/** Interpolated position along a grenade's recorded flight, or null if not airborne. */
function nadeAt(nade: PreviewNade, tick: number) {
  const points = nade.points;
  if (!points?.length) return null;
  if (tick < points[0].tick || tick > points[points.length - 1].tick) return null;
  let i = 0;
  while (i < points.length - 2 && points[i + 1].tick <= tick) i += 1;
  const a = points[i];
  const b = points[i + 1] ?? a;
  const span = b.tick - a.tick;
  const t = span <= 0 ? 0 : Math.min(1, Math.max(0, (tick - a.tick) / span));
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

function hide(item: THREE.Object3D) {
  item.visible = false;
}

export function updateNadeFx(
  fx: NadeFx,
  data: {
    grenades: PreviewNade[];
    smokes: PreviewVolume[];
    fires: PreviewVolume[];
    bursts: PreviewBurst[];
  },
  tick: number,
  tickrate: number,
) {
  const rate = Math.max(tickrate, 1);

  // Grenades in flight, each with a short trail behind it.
  let slot = 0;
  for (const nade of data.grenades ?? []) {
    if (slot >= MAX_NADES) break;
    const at = nadeAt(nade, tick);
    if (!at) continue;
    const { mesh, trail } = fx.nades[slot];
    const p = cs2ToThree(at.x, at.y, at.z);
    mesh.position.set(p.x, p.y, p.z);
    mesh.visible = true;
    (mesh.material as THREE.MeshLambertMaterial).color.setHex(
      NADE_COLOR[nade.kind] ?? 0x6b8f3a,
    );
    for (let t = 0; t < TRAIL; t += 1) {
      const back = nadeAt(nade, tick - (t + 1) * 2);
      const puff = trail[t];
      if (!back) {
        hide(puff);
        continue;
      }
      const q = cs2ToThree(back.x, back.y, back.z);
      puff.position.set(q.x, q.y, q.z);
      puff.visible = true;
      const fade = 1 - (t + 1) / (TRAIL + 1);
      (puff.material as THREE.SpriteMaterial).opacity = fade * 0.3;
      const size = 7 * fade + 2;
      puff.scale.set(size, size, 1);
    }
    slot += 1;
  }
  for (let i = slot; i < MAX_NADES; i += 1) {
    hide(fx.nades[i].mesh);
    fx.nades[i].trail.forEach(hide);
  }

  // Smokes: a dark occluding core plus a ball of puffs that blooms then thins.
  slot = 0;
  for (const smoke of data.smokes ?? []) {
    if (slot >= MAX_SMOKES) break;
    const phase = volumePhase(smoke, tick, rate, SMOKE_SECONDS);
    if (phase === null) continue;
    const alpha = envelope(phase, 0.06, 0.18);
    const { puffs, core } = fx.smokes[slot];
    const seed = smoke.id ?? smoke.tick;
    const grow = Math.min(1, phase / 0.06);
    const centre = cs2ToThree(smoke.x, smoke.y, smoke.z);
    const radius = SMOKE_RADIUS * grow;
    core.position.set(centre.x, centre.y + radius * 0.45, centre.z);
    core.scale.setScalar(radius * 0.72);
    core.visible = alpha > 0.01;
    (core.material as THREE.MeshLambertMaterial).opacity = alpha * 0.55;
    for (let p = 0; p < PUFFS; p += 1) {
      const off = clusterOffset(seed, p);
      const puff = puffs[p];
      puff.position.set(
        centre.x + off.x * SMOKE_RADIUS * 0.75 * grow,
        centre.y + (off.y * 0.35 + 0.5) * SMOKE_RADIUS * grow,
        centre.z + off.z * SMOKE_RADIUS * 0.75 * grow,
      );
      const size = SMOKE_RADIUS * (0.85 + 0.28 * off.x) * grow;
      puff.scale.set(size, size, 1);
      puff.visible = alpha > 0.01;
      (puff.material as THREE.SpriteMaterial).opacity = alpha * 0.72;
    }
    slot += 1;
  }
  for (let i = slot; i < MAX_SMOKES; i += 1) {
    fx.smokes[i].puffs.forEach(hide);
    hide(fx.smokes[i].core);
  }

  // Molotov: ground pool plus yellow-core / orange-rim flames.
  slot = 0;
  for (const fire of data.fires ?? []) {
    if (slot >= MAX_FIRES) break;
    const phase = volumePhase(fire, tick, rate, FIRE_SECONDS);
    if (phase === null) continue;
    const alpha = envelope(phase, 0.08, 0.25);
    const { flames, pool } = fx.fires[slot];
    const seed = fire.id ?? fire.tick;
    const centre = cs2ToThree(fire.x, fire.y, fire.z);
    pool.position.set(centre.x, centre.y + 2, centre.z);
    pool.scale.setScalar(FIRE_RADIUS);
    pool.visible = alpha > 0.01;
    (pool.material as THREE.MeshBasicMaterial).opacity = alpha * 0.55;
    for (let f = 0; f < FLAMES; f += 1) {
      const off = clusterOffset(seed, f);
      const flicker = 0.7 + 0.3 * Math.sin(tick * 0.4 + f * 1.7);
      const flame = flames[f];
      flame.position.set(
        centre.x + off.x * FIRE_RADIUS * 0.85,
        centre.y + 18 + off.y * 10 + flicker * 10,
        centre.z + off.z * FIRE_RADIUS * 0.85,
      );
      const size = (f % 2 === 0 ? 88 : 72) * (0.7 + 0.3 * off.z) * flicker;
      flame.scale.set(size, size * 1.15, 1);
      flame.visible = alpha > 0.01;
      (flame.material as THREE.SpriteMaterial).opacity = alpha * 0.85 * flicker;
    }
    slot += 1;
  }
  for (let i = slot; i < MAX_FIRES; i += 1) {
    fx.fires[i].flames.forEach(hide);
    hide(fx.fires[i].pool);
  }

  // HE and flashbang: one expanding shell each.
  slot = 0;
  for (const burst of data.bursts ?? []) {
    if (slot >= MAX_BURSTS) break;
    const age = (tick - burst.tick) / rate;
    if (age < 0 || age > BURST_SECONDS) continue;
    const t = age / BURST_SECONDS;
    const item = fx.bursts[slot];
    const p = cs2ToThree(burst.x, burst.y, burst.z);
    item.position.set(p.x, p.y, p.z);
    const size = 90 + 260 * t;
    item.scale.set(size, size, 1);
    item.visible = true;
    (item.material as THREE.SpriteMaterial).color.setHex(
      burst.kind === "flash" ? 0xffffff : 0xffb066,
    );
    (item.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - t) * 0.9;
    slot += 1;
  }
  for (let i = slot; i < MAX_BURSTS; i += 1) hide(fx.bursts[i]);
}

export function disposeNadeFx(fx: NadeFx) {
  for (const material of fx.shared.materials) material.dispose();
  fx.shared.sphere.dispose();
  fx.shared.core.dispose();
  fx.shared.disc.dispose();
  fx.shared.soft.dispose();
}
