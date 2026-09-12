/**
 * Measure idle_deagle vs the Deagle mesh so we can see why the gun sits on the arms.
 *
 *   npx tsx scripts/check-deagle-attach.mts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { collectBones, findClip, instantiate, meshBounds } from "../src/renderer/src/lib/gameAssets";
import { applyBlendedPose, extractPose } from "../src/renderer/src/lib/armsViewmodel";
import { tipCentroid } from "../src/renderer/src/lib/weaponModels";

const cache = join(process.env.LOCALAPPDATA ?? "", "cs2-reel", "assets");

async function load(p: string) {
  const b = readFileSync(p);
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  return new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>((res, rej) =>
    new GLTFLoader().parse(buf, "", (g) => res({ scene: g.scene as THREE.Group, animations: g.animations }), rej),
  );
}

const agent = await load(join(cache, "agents", "models", "ctm_sas", "ctm_sas.glb"));
const gun = await load(join(cache, "weapons", "models", "deagle", "weapon_pist_deagle.glb"));
const clip = findClip(agent.animations, "idle_deagle");
if (!clip) {
  console.error("idle_deagle missing. clips:", agent.animations.map((c) => c.name).filter((n) => /deagle|idle/i.test(n)).slice(0, 40));
  process.exit(1);
}

console.log("clip", clip.name, "tracks", clip.tracks.length, "duration", clip.duration);
const pose = extractPose(clip);
const poseBones = [...pose.keys()].sort();
console.log("pose bones", poseBones.length);
for (const n of ["wpn", "wpnPivot", "wpnEnd", "hand_R", "hand_L", "root_motion", "weapon"]) {
  console.log(`  pose has ${n.padEnd(12)} ${pose.has(n)}`);
}
console.log(
  "  pose bones matching /wpn|hand|weapon/i",
  poseBones.filter((n) => /wpn|hand|weapon/i.test(n)).join(", ") || "(none)",
);

const { root, model } = instantiate(agent, { flipForward: true });
const bones = collectBones(model);
applyBlendedPose(bones, pose, null, 0);
model.updateMatrixWorld(true);

function at(name: string) {
  const b = bones.get(name);
  if (!b) return null;
  return b.getWorldPosition(new THREE.Vector3());
}
function fmt(v: THREE.Vector3 | null) {
  return v ? `x ${v.x.toFixed(3)} y ${v.y.toFixed(3)} z ${v.z.toFixed(3)}  |${v.length().toFixed(3)}|` : "MISSING";
}

console.log("\n--- posed agent (metres * inches wrapper, flip Y 180) ---");
for (const n of ["wpn", "wpnPivot", "hand_R", "hand_L", "root_motion", "pelvis", "head_0"]) {
  console.log(`  ${n.padEnd(12)} ${fmt(at(n))}`);
}

const inst = instantiate(gun, { flipForward: false, scale: 1 });
const wBones = collectBones(inst.model);
const preBounds = meshBounds(inst.root);
const preTip = tipCentroid(inst.root, preBounds, 1);
const muzzleObj = new THREE.Object3D();
muzzleObj.name = "muzzle";
muzzleObj.position.copy(inst.model.worldToLocal(preTip.clone()));
inst.model.add(muzzleObj);
console.log("\n--- deagle nodes ---");
const names: string[] = [];
inst.root.traverse((c) => {
  if (c.name) names.push(`${c.type}:${c.name}`);
});
console.log(" ", names.filter((n) => /weapon|hand|ag1|offset|root|Scene/i.test(n)).join("\n  "));
console.log("  mesh bounds (attached space)", meshBounds(inst.root).getSize(new THREE.Vector3()).toArray().map((n) => n.toFixed(3)));
const bounds = meshBounds(inst.root);
console.log("  box", `min ${bounds.min.toArray().map((n) => n.toFixed(3))} max ${bounds.max.toArray().map((n) => n.toFixed(3))}`);
const tip = tipCentroid(inst.root, bounds, 1);
console.log("  tip +Z", tip.toArray().map((n) => n.toFixed(3)));
for (const n of ["weapon", "weapon_offset", "ag1_hand_r", "ag1_hand_l"]) {
  const b = wBones.get(n);
  if (!b) {
    console.log(`  ${n} MISSING`);
    continue;
  }
  const p = b.getWorldPosition(new THREE.Vector3());
  console.log(`  ${n.padEnd(14)} ${fmt(p)}`);
}

const wpn = bones.get("wpn");
const handR = bones.get("hand_R");
if (!wpn || !handR) {
  console.error("missing wpn or hand_R");
  process.exit(1);
}

function attachIdentity(target: THREE.Object3D) {
  target.add(inst.root);
  inst.root.position.set(0, 0, 0);
  inst.root.quaternion.identity();
  inst.root.scale.setScalar(1);
  root.updateMatrixWorld(true);
}

function attachGuide(target: THREE.Object3D, guideName: string) {
  const guide = wBones.get(guideName);
  target.add(inst.root);
  inst.root.position.set(0, 0, 0);
  inst.root.quaternion.identity();
  inst.root.scale.setScalar(1);
  if (!guide) return;
  inst.root.updateMatrixWorld(true);
  guide.updateMatrixWorld(true);
  const rel = new THREE.Matrix4().copy(inst.root.matrixWorld).invert().multiply(guide.matrixWorld);
  rel.invert().decompose(inst.root.position, inst.root.quaternion, inst.root.scale);
  root.updateMatrixWorld(true);
}

function report(label: string) {
  const muzzle = muzzleObj.getWorldPosition(new THREE.Vector3());
  const grip = wBones.get("ag1_hand_r")?.getWorldPosition(new THREE.Vector3()) ?? null;
  const hr = handR.getWorldPosition(new THREE.Vector3());
  const hl = bones.get("hand_L")!.getWorldPosition(new THREE.Vector3());
  const wp = wpn.getWorldPosition(new THREE.Vector3());
  const dGrip = grip ? grip.distanceTo(hr) : -1;
  const barrel = grip ? muzzle.clone().sub(grip) : muzzle.clone();
  console.log(
    `\n${label}\n  muzzle ${muzzle.toArray().map((n) => n.toFixed(3))}\n  ag1    ${grip ? grip.toArray().map((n) => n.toFixed(3)) : "none"} distHandR=${dGrip.toFixed(3)}\n  barrel ${barrel.toArray().map((n) => n.toFixed(3))}  towardCam=${barrel.z > 0}\n  hand_R ${hr.toArray().map((n) => n.toFixed(3))}\n  hand_L ${hl.toArray().map((n) => n.toFixed(3))}\n  wpn    ${wp.toArray().map((n) => n.toFixed(3))}`,
  );
}

function axes(obj: THREE.Object3D, label: string) {
  obj.updateMatrixWorld(true);
  const e = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  obj.matrixWorld.decompose(e, q, s);
  const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
  const y = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
  const z = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  console.log(
    `  ${label} +X ${x.toArray().map((n) => n.toFixed(2))} +Y ${y.toArray().map((n) => n.toFixed(2))} +Z ${z.toArray().map((n) => n.toFixed(2))}`,
  );
}

console.log("\n--- bone axes ---");
axes(wpn, "wpn");
axes(handR, "hand_R");
axes(wBones.get("ag1_hand_r")!, "ag1 (unparented)");
axes(wBones.get("weapon")!, "weapon bone (unparented)");

attachIdentity(wpn);
report("identity on wpn");
attachGuide(wpn, "ag1_hand_r");
report("ag1_hand_r -> wpn");
attachGuide(handR, "ag1_hand_r");
report("ag1_hand_r -> hand_R");
axes(inst.root, "gun root after ag1->hand_R");
attachGuide(wpn, "weapon");
report("weapon bone -> wpn");

function applyWorldRotationAround(obj: THREE.Object3D, pivot: THREE.Vector3, rot: THREE.Quaternion) {
  obj.updateMatrixWorld(true);
  const parent = obj.parent;
  if (!parent) return;
  parent.updateMatrixWorld(true);
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  obj.matrixWorld.decompose(pos, quat, scl);
  const newPos = pos.clone().sub(pivot).applyQuaternion(rot).add(pivot);
  const newQuat = rot.clone().multiply(quat);
  const inv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
  const local = new THREE.Matrix4().compose(newPos, newQuat, scl).premultiply(inv);
  local.decompose(obj.position, obj.quaternion, obj.scale);
}

console.log("\n--- ag1 on hand_R, then barrel to -Z ---");
attachGuide(handR, "ag1_hand_r");
{
  const g = wBones.get("ag1_hand_r")!.getWorldPosition(new THREE.Vector3());
  const m = muzzleObj.getWorldPosition(new THREE.Vector3());
  const barrel = m.sub(g);
  if (barrel.lengthSq() > 1e-8) {
    barrel.normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(barrel, new THREE.Vector3(0, 0, -1));
    applyWorldRotationAround(inst.root, g, q);
    root.updateMatrixWorld(true);
  }
}
report("ag1->hand_R then barrel -Z");