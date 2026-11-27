/**
 * Assert knife seat, Deagle dip, and TP rifle attach.
 *
 *   npx tsx scripts/check-hold-fix.mts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { collectBones, findClip, instantiate, meshBounds } from "../src/renderer/src/lib/gameAssets";
import {
  applyBlendedPose,
  extractPose,
  hideMesh,
  placeArmsViewmodel,
  BODY_MESH,
  PLACEHOLDER_MESH,
  type ArmsViewmodel,
} from "../src/renderer/src/lib/armsViewmodel";
import { attachViewmodelWeapon, attachWeapon, tipCentroid, type WeaponModel } from "../src/renderer/src/lib/weaponModels";
import { WEAPONS } from "../src/renderer/src/lib/weaponTable";

const cache = join(process.env.LOCALAPPDATA ?? "", "cs2-reel", "assets");

async function load(p: string) {
  const b = readFileSync(p);
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  return new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>((res, rej) =>
    new GLTFLoader().parse(buf, "", (g) => res({ scene: g.scene as THREE.Group, animations: g.animations }), rej),
  );
}

function fail(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  return ok ? 0 : 1;
}

function fmt(v: THREE.Vector3) {
  return v.toArray().map((n) => n.toFixed(3)).join(" ");
}

function weaponFrom(
  glb: { scene: THREE.Group; animations: THREE.AnimationClip[] },
  info: (typeof WEAPONS)[string],
): WeaponModel {
  const inst = instantiate(glb, { flipForward: false, scale: 1 });
  const bones = collectBones(inst.model);
  const tip = tipCentroid(inst.root, meshBounds(inst.root), 1);
  const muzzle = new THREE.Object3D();
  muzzle.name = "muzzle";
  muzzle.position.copy(inst.model.worldToLocal(tip.clone()));
  inst.model.add(muzzle);
  return {
    root: inst.root,
    muzzle,
    guide: bones.get("weapon") ?? null,
    handGuide: bones.get("ag1_hand_r") ?? null,
    info,
    length: 0,
    bounds: meshBounds(inst.root),
    mixer: null,
    shoot: null,
    reload: null,
    reloadSeconds: 0,
    shootSeconds: 0,
  };
}

function nearestTo(root: THREE.Object3D, target: THREE.Vector3) {
  const point = new THREE.Vector3();
  let best = Infinity;
  root.updateMatrixWorld(true);
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible || !mesh.geometry) return;
    const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos) return;
    for (let i = 0; i < pos.count; i += 6) {
      point.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      best = Math.min(best, point.distanceTo(target));
    }
  });
  return best;
}

const sas = await load(join(cache, "agents", "models", "ctm_sas", "ctm_sas.glb"));
const knifeGlb = await load(join(cache, "weapons", "models", "knife", "knife_default_t", "weapon_knife_default_t.glb"));
const deagleGlb = await load(join(cache, "weapons", "models", "deagle", "weapon_pist_deagle.glb"));
const m4Glb = await load(join(cache, "weapons", "models", "m4a1_silencer", "weapon_rif_m4a1_silencer.glb"));

let failures = 0;

console.log("\n===== knife idle_default_t =====");
{
  const clip = findClip(sas.animations, "idle_default_t")!;
  const { root, model } = instantiate(sas, { flipForward: true });
  hideMesh(model, BODY_MESH);
  hideMesh(model, PLACEHOLDER_MESH);
  hideMesh(model, "firstperson_sleeves");
  const bones = collectBones(model);
  applyBlendedPose(bones, extractPose(clip), null, 0);
  model.updateMatrixWorld(true);
  const weapon = weaponFrom(knifeGlb, WEAPONS.knife_default_t);
  const hand = bones.get("hand_R")!;
  attachViewmodelWeapon(weapon, hand);
  const vm: ArmsViewmodel = {
    root,
    model,
    bones,
    wpnBone: bones.get("wpn") ?? null,
    headBone: bones.get("head_0") ?? null,
    poses: { idle: extractPose(clip), shoot: null, reload: null, draw: null },
    weapon,
    info: WEAPONS.knife_default_t,
    bobPhase: 0,
    swayYaw: Number.NaN,
    swayPitch: Number.NaN,
  };
  placeArmsViewmodel(vm, new THREE.PerspectiveCamera(54, 16 / 9, 0.1, 400));
  const hr = hand.getWorldPosition(new THREE.Vector3());
  const box = meshBounds(weapon.root);
  const blade = box.getCenter(new THREE.Vector3()).sub(hr);
  console.log("  hand", fmt(hr), "box", fmt(box.min), "..", fmt(box.max));
  console.log("  nearestR", nearestTo(weapon.root, hr).toFixed(2), "bladeFromHand", fmt(blade));
  failures += fail("knife stays in the right hand", nearestTo(weapon.root, hr) < 1.2, nearestTo(weapon.root, hr).toFixed(2));
  failures += fail("pommel does not run past the wrist", box.max.x < hr.x + 3.6, `maxX=${box.max.x.toFixed(2)} handX=${hr.x.toFixed(2)}`);
  failures += fail("blade reaches left of the fist", box.min.x < hr.x - 4, `minX=${box.min.x.toFixed(2)}`);
  failures += fail("blade has a forward component (off the forearm)", box.min.z < hr.z - 1.5, `minZ=${box.min.z.toFixed(2)} handZ=${hr.z.toFixed(2)}`);
}

console.log("\n===== deagle idle =====");
{
  const clip = findClip(sas.animations, "idle_deagle")!;
  const { root, model } = instantiate(sas, { flipForward: true });
  hideMesh(model, BODY_MESH);
  hideMesh(model, PLACEHOLDER_MESH);
  hideMesh(model, "firstperson_sleeves");
  const bones = collectBones(model);
  applyBlendedPose(bones, extractPose(clip), null, 0);
  model.updateMatrixWorld(true);
  const weapon = weaponFrom(deagleGlb, WEAPONS.deagle);
  attachViewmodelWeapon(weapon, bones.get("wpn")!);
  const vm: ArmsViewmodel = {
    root,
    model,
    bones,
    wpnBone: bones.get("wpn") ?? null,
    headBone: bones.get("head_0") ?? null,
    poses: { idle: extractPose(clip), shoot: null, reload: null, draw: null },
    weapon,
    info: WEAPONS.deagle,
    bobPhase: 0,
    swayYaw: Number.NaN,
    swayPitch: Number.NaN,
  };
  placeArmsViewmodel(vm, new THREE.PerspectiveCamera(54, 16 / 9, 0.1, 400));
  const bore = new THREE.Vector3(0, 0, 1).transformDirection(weapon.root.matrixWorld);
  const grip = weapon.handGuide!.getWorldPosition(new THREE.Vector3());
  const hand = bones.get("hand_R")!.getWorldPosition(new THREE.Vector3());
  console.log("  bore", fmt(bore), "grip", fmt(grip));
  failures += fail("bore still toward the lens", bore.z < -0.92 && Math.abs(bore.x) < 0.2, fmt(bore));
  failures += fail("grip hangs into the hands (not parked on the fists)", grip.distanceTo(hand) > 1.2 && grip.distanceTo(hand) < 3.2, grip.distanceTo(hand).toFixed(2));
  failures += fail("both hands near the gun", nearestTo(weapon.root, hand) < 2.2 && nearestTo(weapon.root, bones.get("hand_L")!.getWorldPosition(new THREE.Vector3())) < 2.2, `R=${nearestTo(weapon.root, hand).toFixed(2)}`);
}

console.log("\n===== TP M4A1-S idle_rifle =====");
{
  const clip = findClip(sas.animations, "idle_rifle")!;
  const { root, model } = instantiate(sas, { flipForward: false });
  model.rotation.y = Math.PI;
  const bones = collectBones(model);
  const mixer = new THREE.AnimationMixer(model);
  const action = mixer.clipAction(clip);
  action.play();
  action.paused = true;
  mixer.update(0);
  root.updateMatrixWorld(true);
  const weapon = weaponFrom(m4Glb, WEAPONS.m4a1_silencer);
  const wpn = bones.get("wpn")!;
  attachWeapon(weapon, wpn, "weapon");
  root.updateMatrixWorld(true);
  const hr = bones.get("hand_R")!.getWorldPosition(new THREE.Vector3());
  const hl = bones.get("hand_L")!.getWorldPosition(new THREE.Vector3());
  const nr = nearestTo(weapon.root, hr);
  const nl = nearestTo(weapon.root, hl);
  const bore = new THREE.Vector3(0, 0, 1).transformDirection(weapon.root.matrixWorld);
  console.log("  nearestR", nr.toFixed(2), "nearestL", nl.toFixed(2), "bore", fmt(bore));
  failures += fail("rifle between both hands", nr < 3 && nl < 3, `R=${nr.toFixed(2)} L=${nl.toFixed(2)}`);
  failures += fail("barrel points character forward (-Z)", bore.z < -0.9, fmt(bore));
}

console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
process.exit(failures ? 1 : 0);
