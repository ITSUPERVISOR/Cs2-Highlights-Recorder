import * as THREE from "three";
import { cs2ToThree, shotsInWindow, type PreviewShot } from "./clipPlayback";
import { cs2Forward } from "./viewAngles";

/**
 * Bullet tracers and muzzle flashes for every player.
 *
 * Shots are frequent, so slots are pooled and reused rather than allocated per
 * shot. Everything is driven from the current tick, never from wall time, so
 * scrubbing shows the shots that belong to that moment.
 */

/** Clip-seconds a tracer stays visible. Short: this reads as a streak, not a beam. */
const TRACER_LIFE = 0.09;
const FLASH_LIFE = 0.06;
const IMPACT_LIFE = 0.08;
/** How long the streak takes to travel the recorded path. */
const TRAVEL = 0.04;
const SLOTS = 24;
/** A miss has no recorded distance, so it gets a long streak instead. */
const MISS_LENGTH = 3000;
const STREAK_LENGTH = 160;
const TRACER_RADIUS = 0.7;
const TRACER_CORE = 0.28;
const TRACER_COLOR = 0xffe6a8;
const TRACER_CORE_COLOR = 0xfff6d8;

const UP = new THREE.Vector3(0, 1, 0);

export type TracerPool = {
  group: THREE.Group;
  tracers: THREE.Mesh[];
  cores: THREE.Mesh[];
  flashes: THREE.Sprite[];
  impacts: THREE.Sprite[];
  light: THREE.PointLight;
  shared: { geometry: THREE.CylinderGeometry; texture: THREE.Texture };
};

/** Soft radial blob, used for muzzle flashes and grenade effects. */
export function makeGlowTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const half = size / 2;
    const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.35, "rgba(255,214,138,0.7)");
    gradient.addColorStop(1, "rgba(255,170,70,0)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  return new THREE.CanvasTexture(canvas);
}

export function makeTracerPool(): TracerPool {
  const group = new THREE.Group();
  group.name = "tracers";
  // Unit cylinder along +Y, scaled to each shot's length.
  const geometry = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  const texture = makeGlowTexture();

  const tracers: THREE.Mesh[] = [];
  const cores: THREE.Mesh[] = [];
  const flashes: THREE.Sprite[] = [];
  const impacts: THREE.Sprite[] = [];
  for (let i = 0; i < SLOTS; i += 1) {
    // Per-slot materials, because each shot fades on its own clock.
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: TRACER_COLOR,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    mesh.visible = false;
    mesh.frustumCulled = false;
    tracers.push(mesh);
    group.add(mesh);

    const core = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: TRACER_CORE_COLOR,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    core.visible = false;
    core.frustumCulled = false;
    cores.push(core);
    group.add(core);

    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    sprite.visible = false;
    flashes.push(sprite);
    group.add(sprite);

    const impact = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        color: 0xffc878,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    impact.visible = false;
    impacts.push(impact);
    group.add(impact);
  }

  // One shared light: a light per shot would be far more expensive than the
  // effect is worth, and only the newest flash needs to throw any.
  const light = new THREE.PointLight(0xffd090, 0, 700, 2);
  light.visible = false;
  group.add(light);

  return { group, tracers, cores, flashes, impacts, light, shared: { geometry, texture } };
}

/** Place a short streak part-way along the shot, travelling with age. */
function aimTracer(mesh: THREE.Mesh, shot: PreviewShot, age: number, radius: number, start = 0) {
  const dir = cs2Forward(shot.pitch, shot.yaw);
  const origin = cs2ToThree(shot.ox, shot.oy, shot.oz);
  const eye = new THREE.Vector3(origin.x, origin.y, origin.z);
  const from = eye.clone().addScaledVector(dir, start);
  const full = shot.dist && shot.dist > 0 ? shot.dist : MISS_LENGTH;
  const path = Math.max(10, full - start);
  const head = Math.min(path, (age / TRAVEL) * full);
  const tail = Math.max(0, head - STREAK_LENGTH);
  const length = Math.max(10, head - tail);
  mesh.position.copy(from).addScaledVector(dir, tail + length / 2);
  mesh.quaternion.setFromUnitVectors(UP, dir);
  mesh.scale.set(radius, length, radius);
  const hit = shot.dist && shot.dist > 0 ? eye.clone().addScaledVector(dir, shot.dist) : null;
  return { from, hit };
}

export function updateTracers(
  pool: TracerPool,
  shots: PreviewShot[],
  tick: number,
  tickrate: number,
  povSteamid?: string | null,
) {
  const live = shotsInWindow(shots, tick, tickrate, TRACER_LIFE);
  const rate = Math.max(tickrate, 1);
  let slot = 0;
  let newest: { at: number; life: number } | null = null;

  for (const shot of live) {
    if (slot >= SLOTS) break;
    const age = (tick - shot.tick) / rate;
    const mesh = pool.tracers[slot];
    const sprite = pool.flashes[slot];
    const own = Boolean(povSteamid && shot.steamid === povSteamid);

    const fade = 1 - Math.min(1, age / TRACER_LIFE);
    const { from, hit } = aimTracer(mesh, shot, age, TRACER_RADIUS, own ? 36 : 10);
    mesh.visible = fade > 0;
    (mesh.material as THREE.MeshBasicMaterial).opacity = fade * 0.7;

    const core = pool.cores[slot];
    aimTracer(core, shot, age, TRACER_CORE, own ? 36 : 10);
    core.visible = fade > 0;
    (core.material as THREE.MeshBasicMaterial).opacity = fade;

    const impact = pool.impacts[slot];
    const impactAge = age - TRAVEL;
    if (hit && impactAge >= 0 && impactAge < IMPACT_LIFE) {
      const spark = 1 - impactAge / IMPACT_LIFE;
      impact.visible = true;
      impact.position.copy(hit);
      const size = 18 * (0.45 + 0.55 * (1 - spark));
      impact.scale.set(size, size, 1);
      (impact.material as THREE.SpriteMaterial).opacity = spark;
    } else {
      impact.visible = false;
    }

    // POV shots already have a viewmodel muzzle flash. A sprite at the eye
    // fills the lens, which is the "big flash" on every shot.
    const flashFade = own ? 0 : 1 - Math.min(1, age / FLASH_LIFE);
    sprite.visible = flashFade > 0;
    sprite.position.copy(from);
    const size = 8 * (0.7 + 0.4 * (1 - flashFade));
    sprite.scale.set(size, size, 1);
    (sprite.material as THREE.SpriteMaterial).opacity = flashFade * 0.85;

    if (flashFade > 0 && (!newest || shot.tick > newest.at)) {
      newest = { at: shot.tick, life: flashFade };
      pool.light.position.copy(from);
    }
    slot += 1;
  }

  for (let i = slot; i < SLOTS; i += 1) {
    pool.tracers[i].visible = false;
    pool.cores[i].visible = false;
    pool.flashes[i].visible = false;
    pool.impacts[i].visible = false;
  }

  pool.light.visible = newest !== null;
  pool.light.intensity = newest ? 280 * newest.life : 0;
}

export function disposeTracerPool(pool: TracerPool) {
  for (const mesh of pool.tracers) (mesh.material as THREE.Material).dispose();
  for (const mesh of pool.cores) (mesh.material as THREE.Material).dispose();
  for (const sprite of pool.flashes) (sprite.material as THREE.Material).dispose();
  for (const sprite of pool.impacts) (sprite.material as THREE.Material).dispose();
  pool.shared.geometry.dispose();
  pool.shared.texture.dispose();
}
