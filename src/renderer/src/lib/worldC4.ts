/**
 * The C4 pack sitting on the ground after a drop, or planted on a site.
 *
 * Driven from dump spans so scrubbing shows the bomb only while it is actually
 * in the world — not while someone is carrying it.
 */

import * as THREE from "three";
import { bombAt, cs2ToThree, type PreviewBomb } from "./clipPlayback";
import { makeWeaponMesh } from "./playerRig";
import { disposeWeaponModel, makeWeaponModel, type WeaponModel } from "./weaponModels";
import { resolveWeapon } from "./weaponTable";
import type { AssetBundle } from "./gameAssets";

export type WorldC4 = {
  group: THREE.Group;
  fallback: THREE.Group;
  real: WeaponModel | null;
  led: THREE.Mesh;
};

export function makeWorldC4(): WorldC4 {
  const group = new THREE.Group();
  group.name = "worldC4";
  group.visible = false;
  const fallback = makeWeaponMesh("c4");
  group.add(fallback);
  const led = new THREE.Mesh(
    new THREE.SphereGeometry(1.4, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xff3b2a }),
  );
  led.position.set(0, 5, 0);
  led.visible = false;
  group.add(led);
  return { group, fallback, real: null, led };
}

export function updateWorldC4(fx: WorldC4, bombs: PreviewBomb[] | undefined, tick: number) {
  const bomb = bombAt(bombs, tick);
  if (!bomb) {
    fx.group.visible = false;
    return;
  }
  const p = cs2ToThree(bomb.x, bomb.y, bomb.z);
  fx.group.position.set(p.x, p.y + 3, p.z);
  // Lie it on the floor rather than standing like a held pack.
  fx.group.rotation.set(bomb.kind === "planted" ? -1.05 : -0.7, bomb.kind === "planted" ? 0.35 : 0.8, 0);
  fx.led.visible = bomb.kind === "planted";
  fx.group.visible = true;
}

export async function bindWorldC4Model(fx: WorldC4, bundle: AssetBundle | null) {
  if (fx.real) return;
  const model = await makeWeaponModel(bundle, resolveWeapon("c4"), { attached: false });
  if (!model || fx.real) {
    if (model) disposeWeaponModel(model);
    return;
  }
  fx.real = model;
  fx.fallback.visible = false;
  fx.group.add(model.root);
}

export function disposeWorldC4(fx: WorldC4) {
  disposeWeaponModel(fx.real);
  fx.real = null;
  fx.fallback.removeFromParent();
  fx.fallback.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const mat = mesh.material;
    if (!mat) return;
    for (const item of Array.isArray(mat) ? mat : [mat]) item.dispose();
  });
  fx.led.geometry.dispose();
  (fx.led.material as THREE.Material).dispose();
}
