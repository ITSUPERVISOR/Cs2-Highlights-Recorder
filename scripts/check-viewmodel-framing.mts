/**
 * Assert the Deagle viewmodel stays in frame at both Preview sizes.
 *
 *   npx tsx scripts/check-viewmodel-framing.mts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { collectBones, findClip, instantiate } from "../src/renderer/src/lib/gameAssets";
import {
  applyBlendedPose,
  extractPose,
  firstPersonBounds,
  frameArmsInView,
  hideMesh,
  placeArmsViewmodel,
  BODY_MESH,
  PLACEHOLDER_MESH,
  type ArmsViewmodel,
} from "../src/renderer/src/lib/armsViewmodel";
import { attachViewmodelWeapon, tipCentroid } from "../src/renderer/src/lib/weaponModels";
import { meshBounds } from "../src/renderer/src/lib/gameAssets";
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

const agent = await load(join(cache, "agents", "models", "ctm_sas", "ctm_sas.glb"));
const gun = await load(join(cache, "weapons", "models", "deagle", "weapon_pist_deagle.glb"));
const clip = findClip(agent.animations, "idle_deagle");
if (!clip) {
  console.error("idle_deagle missing");
  process.exit(1);
}

function build(): ArmsViewmodel {
  const { root, model, animations } = instantiate(agent, { flipForward: true });
  hideMesh(model, BODY_MESH);
  hideMesh(model, PLACEHOLDER_MESH);
  hideMesh(model, "firstperson_sleeves");
  const bones = collectBones(model);
  applyBlendedPose(bones, extractPose(clip!), null, 0);
  model.updateMatrixWorld(true);
  const inst = instantiate(gun, { flipForward: false, scale: 1 });
  const wBones = collectBones(inst.model);
  const tip = tipCentroid(inst.root, meshBounds(inst.root), 1);
  const muzzle = new THREE.Object3D();
  muzzle.position.copy(inst.model.worldToLocal(tip.clone()));
  inst.model.add(muzzle);
  const weapon = {
    root: inst.root,
    muzzle,
    guide: wBones.get("weapon") ?? null,
    handGuide: wBones.get("ag1_hand_r") ?? null,
    info: WEAPONS.deagle,
    length: 0,
    bounds: meshBounds(inst.root),
    mixer: null,
    shoot: null,
    reload: null,
    reloadSeconds: 0,
    shootSeconds: 0,
  };
  const wpn = bones.get("wpn");
  if (wpn) attachViewmodelWeapon(weapon, wpn);
  return {
    root,
    model,
    bones,
    wpnBone: bones.get("wpn") ?? null,
    headBone: bones.get("head_0") ?? null,
    poses: { idle: extractPose(clip!), shoot: null, reload: null, draw: null },
    weapon,
    info: WEAPONS.deagle,
    bobPhase: 0,
    swayYaw: Number.NaN,
    swayPitch: Number.NaN,
  };
}

const views = [
  { name: "expanded 16:9", aspect: 16 / 9 },
  { name: "small pane ~2.6:1", aspect: 2.6 },
];

let failures = 0;
for (const view of views) {
  console.log(`\n${view.name}`);
  const vm = build();
  const cam = new THREE.PerspectiveCamera(54, view.aspect, 0.1, 400);
  failures += fail("placeArmsViewmodel", placeArmsViewmodel(vm, cam));
  const halfH = Math.tan(THREE.MathUtils.degToRad(27)) * 12;
  const halfW = halfH * view.aspect;
  const box = firstPersonBounds(vm);
  const hand = vm.bones.get("hand_R")!.getWorldPosition(new THREE.Vector3());
  const muzzle = vm.weapon!.muzzle.getWorldPosition(new THREE.Vector3());
  const axis = vm.weapon!.root;
  axis.updateMatrixWorld(true);
  const bore = new THREE.Vector3(0, 0, 1).transformDirection(axis.matrixWorld);
  const grip = vm.weapon!.handGuide?.getWorldPosition(new THREE.Vector3());
  console.log(
    `  grip y ${box.min.y.toFixed(2)}..${box.max.y.toFixed(2)}  x ${box.min.x.toFixed(2)}..${box.max.x.toFixed(2)}  z ${box.min.z.toFixed(2)}..${box.max.z.toFixed(2)}`,
  );
  console.log(`  hand ${hand.x.toFixed(2)} ${hand.y.toFixed(2)} ${hand.z.toFixed(2)}`);
  console.log(`  muzzle ${muzzle.x.toFixed(2)} ${muzzle.y.toFixed(2)} ${muzzle.z.toFixed(2)}`);
  console.log(`  bore ${bore.toArray().map((n) => n.toFixed(3)).join(" ")}`);
  failures += fail("hands in front after place", frameArmsInView(vm), `z=${hand.z.toFixed(2)}`);
  failures += fail("right hand on the right", hand.x > 1, `x=${hand.x.toFixed(2)}`);
  failures += fail("hands in the lower half", hand.y < 0, `y=${hand.y.toFixed(2)}`);
  failures += fail(
    "mesh barrel toward the lens",
    bore.z < -0.92 && Math.abs(bore.x) < 0.2 && Math.abs(bore.y) < 0.2,
    bore.toArray().map((n) => n.toFixed(3)).join(","),
  );
  failures += fail(
    "gun stays with the hands",
    !grip || grip.distanceTo(hand) < 3.2,
    grip ? grip.distanceTo(hand).toFixed(2) : "no grip",
  );
  failures += fail(
    "gun not swung off to the side",
    Math.abs(muzzle.x - hand.x) < 8,
    `muzzleX=${muzzle.x.toFixed(2)} handX=${hand.x.toFixed(2)}`,
  );
  failures += fail("gun not past right edge", box.max.x < halfW * 0.98, `maxX=${box.max.x.toFixed(2)} right=${(halfW * 0.98).toFixed(2)}`);
  failures += fail(
    "does not fill the pane (sleeves not fitted)",
    box.max.y - box.min.y < halfH * 2.2,
    `height=${(box.max.y - box.min.y).toFixed(2)} halfH=${halfH.toFixed(2)}`,
  );
  failures += fail(
    "fills enough of the view (not a barrel stub)",
    box.max.y - box.min.y > halfH * 0.12,
    `height=${(box.max.y - box.min.y).toFixed(2)} halfH=${halfH.toFixed(2)}`,
  );
}

console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
process.exit(failures ? 1 : 0);
