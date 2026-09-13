import * as THREE from "three";
import { cs2ToThree, poseAt, type PreviewDump, type PreviewFrame } from "./clipPlayback";

const TTL = 0.85;
const POOL = 24;

export type DamagePop = {
  tick: number;
  amount: number;
  x: number;
  y: number;
  z: number;
};

/** HP drops between pose samples — works on dumps that never stored shot damage. */
export function healthDrops(frames: PreviewFrame[]): DamagePop[] {
  const out: DamagePop[] = [];
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1];
    const cur = frames[i];
    for (const [id, pose] of Object.entries(cur.players ?? {})) {
      const before = prev.players[id];
      if (!before) continue;
      const amount = Math.round((before.health ?? 0) - (pose.health ?? 0));
      if (amount < 1) continue;
      out.push({ tick: cur.tick, amount, x: pose.x, y: pose.y, z: pose.z + 18 });
    }
  }
  return out;
}

/** Prefer exact bullet hits when the dump carries damage; otherwise HP drops. */
export function damagePopsForDump(dump: PreviewDump): DamagePop[] {
  const fromShots: DamagePop[] = [];
  for (const shot of dump.shots ?? []) {
    const amount = Math.round(shot.damage ?? 0);
    if (amount < 1 || !shot.victim) continue;
    const pose = poseAt(dump.frames, shot.tick, shot.victim);
    if (!pose) continue;
    fromShots.push({ tick: shot.tick, amount, x: pose.x, y: pose.y, z: pose.z + 18 });
  }
  return fromShots.length ? fromShots : healthDrops(dump.frames ?? []);
}

function makeDigitTexture(text: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = "bold 72px ui-sans-serif, Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 8;
    ctx.strokeStyle = "rgba(20,8,0,0.85)";
    ctx.fillStyle = "#ffb020";
    ctx.strokeText(text, 128, 64);
    ctx.fillText(text, 128, 64);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

export type DamageFx = {
  group: THREE.Group;
  sprites: THREE.Sprite[];
};

export function makeDamageFx(): DamageFx {
  const group = new THREE.Group();
  group.name = "damageFx";
  const sprites: THREE.Sprite[] = [];
  for (let i = 0; i < POOL; i++) {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false, opacity: 0 }),
    );
    sprite.visible = false;
    sprite.scale.set(28, 14, 1);
    group.add(sprite);
    sprites.push(sprite);
  }
  return { group, sprites };
}

export function updateDamageFx(fx: DamageFx, pops: DamagePop[], tick: number, tickrate: number) {
  const ttlTicks = Math.max(1, TTL * tickrate);
  const live = pops.filter((pop) => tick >= pop.tick && tick - pop.tick <= ttlTicks);
  for (let i = 0; i < fx.sprites.length; i++) {
    const sprite = fx.sprites[i];
    const pop = live[i];
    if (!pop) {
      sprite.visible = false;
      continue;
    }
    const age = (tick - pop.tick) / ttlTicks;
    const p = cs2ToThree(pop.x, pop.y, pop.z + age * 28);
    sprite.position.set(p.x, p.y, p.z);
    sprite.visible = true;
    const mat = sprite.material as THREE.SpriteMaterial;
    if (mat.userData.amount !== pop.amount) {
      mat.map?.dispose();
      mat.map = makeDigitTexture(`-${pop.amount}`);
      mat.userData.amount = pop.amount;
      mat.needsUpdate = true;
    }
    mat.opacity = 1 - age * age;
    const size = 28 + age * 10;
    sprite.scale.set(size, size * 0.5, 1);
  }
}

export function disposeDamageFx(fx: DamageFx | null) {
  if (!fx) return;
  for (const sprite of fx.sprites) {
    const mat = sprite.material as THREE.SpriteMaterial;
    mat.map?.dispose();
    mat.dispose();
  }
}
