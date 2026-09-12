/**
 * Real CS2 weapon meshes, with their own moving parts.
 *
 * The weapon skeleton is `weapon` -> `weapon_offset` -> {`bolt`, `clip`,
 * `cliprelease`, `trigger`, `ag1_hand_r`}, and unlike the first-person hand
 * poses these animations carry genuine motion: `shoot` is 9 keyframes over
 * 0.267s of bolt travel, `reload` is 74 over 2.433s of magazine work. So the gun
 * cycles and reloads for real; only the hands have to be interpolated between
 * static poses.
 *
 * Everything is driven from the clip tick, never from wall time. Scrubbing
 * backwards has to show the bolt where it was, and an animation advanced by
 * frame delta would drift out of step with the demo and could not rewind.
 */

import * as THREE from "three";
import { applyWeaponMaterials } from "./assetMaterials";
import {
  bundleSkinPath,
  bundleWeaponPath,
  collectBones,
  findClip,
  instantiate,
  loadAsset,
  loadPreviewTexture,
  meshBounds,
  METRES_TO_INCHES,
  type AssetBundle,
} from "./gameAssets";
import { casingModel, type WeaponInfo } from "./weaponTable";

export type WeaponModel = {
  /** Add this to a scene. Inches, -Z forward. */
  root: THREE.Group;
  info: WeaponInfo;
  /**
   * Empty parented at the barrel tip.
   *
   * An object rather than a vector on purpose: the gun gets parented to a hand
   * bone and animated, so any stored coordinate would need re-deriving every
   * frame against whatever space it was measured in. A child's world position is
   * correct by construction.
   */
  muzzle: THREE.Object3D;
  /** Overall length along the barrel axis, in inches. */
  length: number;
  bounds: THREE.Box3;
  /**
   * The weapon's own root bone, `weapon`, which is what a skeleton's `wpn` bone
   * is meant to line up with. Null only if the model has no skeleton.
   */
  guide: THREE.Object3D | null;
  /** Right-hand helper (`ag1_hand_r`). Align this to `hand_R` for a real grip. */
  handGuide: THREE.Object3D | null;
  mixer: THREE.AnimationMixer | null;
  shoot: THREE.AnimationAction | null;
  reload: THREE.AnimationAction | null;
  /** Real duration of the reload clip, so the hands can match it. */
  reloadSeconds: number;
  shootSeconds: number;
};

/**
 * Centroid of the vertices nearest the barrel tip.
 *
 * A bounding-box corner would sit off in space beside the barrel, especially on
 * a rifle with a stock or a scope widening the box. Averaging the front sliver of
 * actual geometry lands on the bore, which is where a muzzle flash has to be.
 */
export function tipCentroid(root: THREE.Object3D, bounds: THREE.Box3, forward: number): THREE.Vector3 {
  // Barrels run along +Z as exported; the facing flip turns that into -Z.
  const span = Math.max(1e-4, bounds.max.z - bounds.min.z);
  const tipZ = forward < 0 ? bounds.min.z : bounds.max.z;
  const cutoff = tipZ + forward * -1 * span * 0.04;
  const inTip = (z: number) => (forward < 0 ? z <= cutoff : z >= cutoff);

  const point = new THREE.Vector3();
  const sum = new THREE.Vector3();
  let count = 0;

  root.updateMatrixWorld(true);
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible || !mesh.geometry) return;
    const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      point.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      if (!inTip(point.z)) continue;
      sum.add(point);
      count++;
    }
  });

  if (!count) {
    const centre = bounds.getCenter(new THREE.Vector3());
    return new THREE.Vector3(centre.x, centre.y, tipZ);
  }
  return sum.multiplyScalar(1 / count);
}

function makeAction(mixer: THREE.AnimationMixer, clip: THREE.AnimationClip | null) {
  if (!clip) return null;
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  // Time is assigned per frame from the tick, so the mixer must not advance it.
  action.paused = true;
  action.enabled = false;
  return action;
}

/**
 * @param attached True when the gun will be parented to a skeleton's weapon
 *   bone. That bone already carries the unit conversion and expects the model in
 *   its authored orientation, so applying either correction again would scale the
 *   gun twice and point it backwards.
 */
export async function makeWeaponModel(
  bundle: AssetBundle | null,
  info: WeaponInfo,
  opts: { attached?: boolean; skinKey?: string } = {},
): Promise<WeaponModel | null> {
  const path = bundleWeaponPath(bundle, info.model);
  if (!path) return null;
  const loaded = await loadAsset(path);
  if (!loaded) return null;

  const attached = opts.attached === true;
  const { root, model, animations } = instantiate(
    loaded,
    attached ? { flipForward: false, scale: 1 } : {},
  );
  root.name = `weapon:${info.id}`;
  const map = opts.skinKey ? await loadPreviewTexture(bundleSkinPath(bundle, opts.skinKey)) : null;
  applyWeaponMaterials(model, info.kind, map);

  // Measured while `root` is still unparented, so these are in root's own space.
  const bounds = meshBounds(root);
  const tip = tipCentroid(root, bounds, attached ? 1 : -1);
  const muzzle = new THREE.Object3D();
  muzzle.name = "muzzle";
  muzzle.position.copy(model.worldToLocal(tip.clone()));
  model.add(muzzle);
  // An attached gun stays in metres so its bone parent can scale it, so the
  // reported length has to be converted to stay comparable across both cases.
  const length = Math.max(0, bounds.max.z - bounds.min.z) * (attached ? METRES_TO_INCHES : 1);

  const shootClip = findClip(animations, "shoot");
  const reloadClip = findClip(animations, "reload");
  const mixer = shootClip || reloadClip ? new THREE.AnimationMixer(model) : null;

  const bones = collectBones(model);

  return {
    root,
    info,
    muzzle,
    length,
    bounds,
    guide: bones.get("weapon") ?? bones.get("weapon_offset") ?? null,
    handGuide: bones.get("ag1_hand_r") ?? bones.get("weapon") ?? null,
    mixer,
    shoot: mixer ? makeAction(mixer, shootClip) : null,
    reload: mixer ? makeAction(mixer, reloadClip) : null,
    reloadSeconds: reloadClip?.duration ?? 0,
    shootSeconds: shootClip?.duration ?? 0,
  };
}

/**
 * Pose the moving parts for this tick.
 *
 * `shotAge` is seconds since the last shot and `reload` is 0..1 through a reload;
 * both are derived from ticks upstream. Reload wins when the two overlap, since
 * the magazine cannot be both seated and out.
 */
export function updateWeaponModel(
  model: WeaponModel,
  opts: { shotAge?: number | null; reload?: number | null },
) {
  const { mixer, shoot, reload } = model;
  if (!mixer) return;

  const reloadPhase = opts.reload ?? null;
  const shotAge = opts.shotAge ?? null;

  let reloadTime: number | null = null;
  let shootTime: number | null = null;
  if (reload && reloadPhase !== null && reloadPhase >= 0 && reloadPhase < 1) {
    reloadTime = reloadPhase * model.reloadSeconds;
  } else if (shoot && shotAge !== null && shotAge >= 0 && shotAge < model.shootSeconds) {
    shootTime = shotAge;
  }

  if (reload) {
    reload.enabled = reloadTime !== null;
    if (reloadTime !== null) reload.time = reloadTime;
  }
  if (shoot) {
    shoot.enabled = shootTime !== null;
    if (shootTime !== null) shoot.time = shootTime;
  }

  // Zero delta: the times above are absolute, so this only re-evaluates and
  // applies them. Anything non-zero would let the clips run on their own.
  mixer.update(0);
}

/**
 * Parent the gun to a skeleton bone.
 *
 * `hand` lines `ag1_hand_r` up with the target — the first-person grip.
 * `weapon` lines the `weapon` bone up with the target — what third-person
 * `wpn` expects. Using the grip helper on `wpn` parks the receiver 5" above
 * the right hand after the inner 180° facing flip.
 */
export function attachWeapon(
  model: WeaponModel,
  target: THREE.Object3D,
  align: "hand" | "weapon" = "hand",
) {
  const guide = align === "weapon" ? model.guide ?? model.handGuide : model.handGuide ?? model.guide;
  target.add(model.root);
  model.root.position.set(0, 0, 0);
  model.root.quaternion.identity();
  model.root.scale.setScalar(1);
  if (!guide) return;
  model.root.updateMatrixWorld(true);
  guide.updateMatrixWorld(true);
  const rel = new THREE.Matrix4().copy(model.root.matrixWorld).invert().multiply(guide.matrixWorld);
  rel.invert().decompose(model.root.position, model.root.quaternion, model.root.scale);
}

function applyWorldRotationAround(obj: THREE.Object3D, pivot: THREE.Vector3, rot: THREE.Quaternion) {
  const parent = obj.parent;
  if (!parent) return;
  obj.updateMatrixWorld(true);
  parent.updateMatrixWorld(true);
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  obj.matrixWorld.decompose(pos, quat, scl);
  const newPos = pos.sub(pivot).applyQuaternion(rot).add(pivot);
  const newQuat = rot.clone().multiply(quat);
  const inv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
  new THREE.Matrix4().compose(newPos, newQuat, scl).premultiply(inv).decompose(obj.position, obj.quaternion, obj.scale);
}

/**
 * First-person attach.
 *
 * Pistols: the idle pose wraps the fingers around `wpn`, not `hand_R`. Align
 * the weapon bone there and leave it — the export already points the bore
 * down the camera. Putting `ag1` on the palm parks the slide on top of the
 * fists, which is the "gun sitting on the hands" look.
 *
 * Rifles: `ag1_hand_r` → `hand_R`, then swing mesh +Z to camera −Z. The
 * `weapon` bone's +Z is *up* in idle, so aiming that at the camera swings
 * the gun out of the hands.
 *
 * Knives: idle wraps the fingers around `wpn`, same as pistols. `ag1` is the
 * guard — parenting that to the palm left the blade floating. Align the weapon
 * bone and only slide the handle if the guard is still clearly in front.
 *
 * Nades and C4: same wrap as pistols. `ag1` is a pin/spoon helper, so lining
 * that up with `hand_R` parks the body on the wrist.
 */
export function attachViewmodelWeapon(model: WeaponModel, target: THREE.Object3D) {
  const pistol = model.info.kind === "pistol" || model.info.kind === "taser";
  if (model.info.kind === "knife") {
    attachWeapon(model, target, "weapon");
    const guide = model.handGuide ?? model.guide;
    if (guide) seatKnifeInHand(model, guide);
    return;
  }
  if (model.info.kind === "nade" || model.info.kind === "c4" || pistol) {
    attachWeapon(model, target, "weapon");
    return;
  }
  attachWeapon(model, target, "hand");
  const guide = model.handGuide ?? model.guide;
  if (!guide) return;
  model.root.updateMatrixWorld(true);
  const barrel = new THREE.Vector3(0, 0, 1).transformDirection(model.root.matrixWorld);
  if (barrel.lengthSq() < 1e-10) return;
  barrel.normalize();
  const forward = new THREE.Vector3(0, 0, -1);
  const grip = guide.getWorldPosition(new THREE.Vector3());
  applyWorldRotationAround(model.root, grip, new THREE.Quaternion().setFromUnitVectors(barrel, forward));

  model.root.updateMatrixWorld(true);
  const grip2 = guide.getWorldPosition(new THREE.Vector3());
  const currentUp = new THREE.Vector3(0, 1, 0).transformDirection(model.root.matrixWorld);
  currentUp.addScaledVector(forward, -currentUp.dot(forward));
  if (currentUp.lengthSq() < 1e-6) return;
  currentUp.normalize();
  const wantUp = new THREE.Vector3(0, 1, 0).addScaledVector(forward, -forward.y);
  if (wantUp.lengthSq() < 1e-6) return;
  wantUp.normalize();
  applyWorldRotationAround(model.root, grip2, new THREE.Quaternion().setFromUnitVectors(currentUp, wantUp));
}

/**
 * After a `wpn` attach the handle should already sit in the fist. Only slide
 * along the blade when `ag1` (the guard) is still clearly in front of the palm.
 */
function seatKnifeInHand(model: WeaponModel, guide: THREE.Object3D) {
  const palm = model.root.parent;
  if (!palm) return;
  model.root.updateMatrixWorld(true);
  palm.updateMatrixWorld(true);
  const guard = guide.getWorldPosition(new THREE.Vector3());
  const fist = palm.getWorldPosition(new THREE.Vector3());
  const ahead = guard.clone().sub(fist);
  // Guard still in front of the palm (camera looks −Z): pull the handle in.
  if (ahead.z > -0.15) return;
  const tip = farthestPoint(model.root, guard);
  const along = tip.sub(guard);
  if (along.lengthSq() < 1e-8) return;
  along.normalize();
  applyWorldTranslation(model.root, along.multiplyScalar(Math.min(0.9, -ahead.z * 0.35)));
}

function farthestPoint(root: THREE.Object3D, origin: THREE.Vector3) {
  const point = new THREE.Vector3();
  let best = origin.clone();
  let bestDist = -1;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible || !mesh.geometry) return;
    const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!pos) return;
    for (let i = 0; i < pos.count; i += 4) {
      point.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      const d = point.distanceToSquared(origin);
      if (d > bestDist) {
        bestDist = d;
        best.copy(point);
      }
    }
  });
  return best;
}

function applyWorldTranslation(obj: THREE.Object3D, delta: THREE.Vector3) {
  const parent = obj.parent;
  if (!parent) return;
  obj.updateMatrixWorld(true);
  parent.updateMatrixWorld(true);
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  obj.matrixWorld.decompose(pos, quat, scl);
  pos.add(delta);
  const inv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
  new THREE.Matrix4().compose(pos, quat, scl).premultiply(inv).decompose(obj.position, obj.quaternion, obj.scale);
}

export function disposeWeaponModel(model: WeaponModel | null) {
  if (!model) return;
  model.mixer?.stopAllAction();
  model.root.removeFromParent();
  // Geometry and materials are shared with the cached asset and other instances,
  // so nothing here is disposed. Only the clone's scene graph is dropped.
}

/** Casing model path for this weapon, for the shell ejection pool. */
export function weaponCasingPath(bundle: AssetBundle | null, info: WeaponInfo): string | null {
  return bundleWeaponPath(bundle, casingModel(info));
}
