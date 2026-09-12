/**
 * Spent shells, ejected from the receiver on each shot.
 *
 * Driven from the shot tick so scrubbing puts every casing where it belongs.
 * Real casing meshes are used when the clip exported them; otherwise a small
 * brass capsule stands in so a missing file never blanks the effect.
 */

import * as THREE from "three";
import { cs2ToThree, shotsInWindow, type PreviewShot } from "./clipPlayback";
import { cs2Forward, cs2ViewEuler } from "./viewAngles";
import { furnitureMaterial } from "./assetMaterials";
import { instantiate, loadAsset, bundleWeaponPath, type AssetBundle } from "./gameAssets";
import { casingModel, resolveWeapon } from "./weaponTable";

const SLOTS = 20;
const LIFE = 1.15;
const GRAVITY = 800;

export type CasingPool = {
  group: THREE.Group;
  slots: THREE.Group[];
  fallback: THREE.BufferGeometry;
};

function fallbackCasing() {
  return new THREE.CapsuleGeometry(0.35, 1.6, 4, 6);
}

export function makeCasingPool(): CasingPool {
  const group = new THREE.Group();
  group.name = "casings";
  const fallback = fallbackCasing();
  const slots: THREE.Group[] = [];
  for (let i = 0; i < SLOTS; i += 1) {
    const slot = new THREE.Group();
    slot.visible = false;
    const mesh = new THREE.Mesh(fallback, furnitureMaterial());
    mesh.rotation.x = Math.PI / 2;
    slot.add(mesh);
    slots.push(slot);
    group.add(slot);
  }
  return { group, slots, fallback };
}

const realCasings = new Map<string, THREE.Group | null>();

async function realCasing(bundle: AssetBundle | null, weapon: string): Promise<THREE.Group | null> {
  const info = resolveWeapon(weapon);
  const model = casingModel(info);
  if (!model) return null;
  if (realCasings.has(model)) return realCasings.get(model) ?? null;
  const path = bundleWeaponPath(bundle, model);
  if (!path) {
    realCasings.set(model, null);
    return null;
  }
  const loaded = await loadAsset(path);
  if (!loaded) {
    realCasings.set(model, null);
    return null;
  }
  const { root } = instantiate(loaded);
  realCasings.set(model, root);
  return root;
}

function bindCasingMesh(
  slot: THREE.Group,
  weapon: string,
  bundle: AssetBundle | null,
  fallback: THREE.BufferGeometry,
) {
  const info = resolveWeapon(weapon);
  const model = casingModel(info);
  const cached = model ? realCasings.get(model) : undefined;
  const key = cached ? model! : "fallback";
  if (slot.userData.casing === key && slot.children.length) return;
  slot.userData.casing = key;
  while (slot.children.length) slot.remove(slot.children[0]);
  if (cached) {
    const clone = cached.clone(true);
    clone.scale.setScalar(1);
    slot.add(clone);
  } else {
    const mesh = new THREE.Mesh(fallback, furnitureMaterial());
    mesh.rotation.x = Math.PI / 2;
    slot.add(mesh);
    if (bundle && model && !realCasings.has(model)) void realCasing(bundle, weapon);
  }
}

function hash(tick: number, index: number) {
  const n = Math.sin(tick * 12.9898 + index * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

export function updateCasings(
  pool: CasingPool,
  shots: PreviewShot[],
  tick: number,
  tickrate: number,
  bundle: AssetBundle | null = null,
) {
  const live = shotsInWindow(shots, tick, tickrate, LIFE);
  const rate = Math.max(tickrate, 1);
  let slot = 0;
  for (const shot of live) {
    if (slot >= SLOTS) break;
    const age = (tick - shot.tick) / rate;
    const fade = 1 - age / LIFE;
    if (fade <= 0) continue;

    const origin = cs2ToThree(shot.ox, shot.oy, shot.oz);
    const forward = cs2Forward(shot.pitch, shot.yaw);
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    else right.normalize();

    const jitter = hash(shot.tick, slot);
    const side = 6 + jitter * 4;
    const up = 4 + hash(shot.tick, slot + 3) * 6;
    const back = 2 + hash(shot.tick, slot + 7) * 3;
    const vx = right.x * (90 + jitter * 40) + forward.x * -20;
    const vy = 140 + hash(shot.tick, slot + 11) * 60;
    const vz = right.z * (90 + jitter * 40) + forward.z * -20;

    const x = origin.x + right.x * side - forward.x * back + vx * age;
    const y = origin.y - 8 + up + vy * age - 0.5 * GRAVITY * age * age;
    const z = origin.z + right.z * side - forward.z * back + vz * age;

    const node = pool.slots[slot];
    bindCasingMesh(node, shot.weapon, bundle, pool.fallback);
    node.visible = y > origin.y - 40;
    node.position.set(x, Math.max(origin.y - 36, y), z);
    node.rotation.copy(cs2ViewEuler(shot.pitch + age * 420, shot.yaw + age * 540));
    node.scale.setScalar(1);
    node.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      if (!mat) return;
      if (mat.transparent || fade < 0.25) {
        mat.transparent = true;
        mat.opacity = Math.min(1, fade * 4);
      }
    });
    slot += 1;
  }
  for (let i = slot; i < SLOTS; i += 1) pool.slots[i].visible = false;
}

export function disposeCasingPool(pool: CasingPool) {
  pool.fallback.dispose();
}
