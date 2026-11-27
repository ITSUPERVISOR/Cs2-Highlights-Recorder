import * as THREE from "three";
import { skinMaterial, sleeveMaterial } from "./assetMaterials";
import { makeWeaponMesh, weaponKind } from "./playerRig";
import { makeGlowTexture } from "./tracers";

/**
 * The first-person weapon, hands included.
 *
 * Drawn by its own camera in a separate pass, so everything here lives in a
 * small space around the origin facing -Z and is positioned by
 * `placeViewmodel` rather than by hand-tuned constants.
 */

/** Distance from the viewmodel camera, in viewmodel units. */
export const VIEWMODEL_DEPTH = 12;
/** Roughly how many units tall the rig is, used to scale it into the frustum. */
const VM_UNITS = 26;

function part(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  return m;
}

/** Forearm running back toward the shoulder, with a fist at the grip. */
function makeArm(mat: THREE.Material, skin: THREE.Material, mirror: boolean) {
  const g = new THREE.Group();
  const side = mirror ? -1 : 1;
  const forearm = part(new THREE.CapsuleGeometry(2.1, 11, 3, 8), mat, 0, 0, 5.5);
  forearm.rotation.x = Math.PI / 2;
  g.add(forearm);
  g.add(part(new THREE.SphereGeometry(2.4, 10, 8), skin, 0, 0, -0.6));
  // Thumb over the top of the weapon.
  g.add(part(new THREE.CapsuleGeometry(0.8, 2.2, 2, 6), skin, side * 1.6, 1.4, -0.4));
  return g;
}

export function makeViewmodelRig(weapon: string): THREE.Group {
  const root = new THREE.Group();
  root.name = "viewmodelRig";
  root.userData.kind = weaponKind(weapon);

  const sleeve = sleeveMaterial();
  const skin = skinMaterial();

  const gun = makeWeaponMesh(weapon);
  root.add(gun);

  // Muzzle flash parked at the business end of whatever weapon this is, rather
  // than at a constant that would be wrong for every gun but one.
  const barrel = new THREE.Box3().setFromObject(gun);
  const flash = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: makeGlowTexture(),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  flash.name = "muzzleFlash";
  flash.position.set(0, barrel.min.y + (barrel.max.y - barrel.min.y) * 0.6, barrel.min.z - 1.5);
  flash.visible = false;
  root.add(flash);
  root.userData.muzzleFlash = flash;

  const kind = root.userData.kind as string;
  const twoHanded = kind !== "pistol" && kind !== "nade" && kind !== "knife";

  // Rear hand on the grip, sitting just behind and below the receiver.
  const rear = makeArm(sleeve, skin, false);
  rear.position.set(1.6, -3.4, 2.2);
  rear.rotation.set(0.32, -0.12, 0.1);
  root.add(rear);

  if (twoHanded) {
    // Support hand forward on the handguard.
    const front = makeArm(sleeve, skin, true);
    front.position.set(-2.2, -2.4, -8.5);
    front.rotation.set(0.22, 0.16, -0.16);
    root.add(front);
  }

  // Carry angle: canted slightly inward and nose-down, like a CS viewmodel.
  root.rotation.set(-0.05, 0.14, 0.06);
  return root;
}

/**
 * Anchor the rig into the frustum's lower right.
 *
 * Placement is derived from frustum *height*, then clamped by width. The
 * Preview viewport can be extremely wide and short, and sizing off width would
 * both shrink the gun and fling it past the right edge.
 */
export function placeViewmodel(root: THREE.Object3D, camera: THREE.PerspectiveCamera) {
  const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * VIEWMODEL_DEPTH;
  const halfW = halfH * Math.max(camera.aspect, 0.0001);
  const nade = (root.userData.kind as string) === "nade";
  root.userData.restX = Math.min(halfH * (nade ? 0.88 : 0.75), halfW * (nade ? 0.58 : 0.45));
  root.userData.restY = -halfH * (nade ? 0.62 : 0.5);
  root.userData.restZ = -VIEWMODEL_DEPTH;
  root.position.set(root.userData.restX, root.userData.restY, root.userData.restZ);
  root.scale.setScalar(halfH / VM_UNITS);
  captureViewmodelRest(root);
}

/** Snapshot the rest pose produced by `placeViewmodel` / `placeArmsViewmodel`. */
export function captureViewmodelRest(root: THREE.Object3D) {
  root.userData.placedX = root.userData.restX ?? 0;
  root.userData.placedY = root.userData.restY ?? 0;
  root.userData.placedZ = root.userData.restZ ?? 0;
  root.userData.baseScale = root.scale.x || 1;
}

/** Offset / scale applied on top of the captured rest pose. Does not remount. */
export function seatViewmodel(
  root: THREE.Object3D,
  prefs: { x: number; y: number; z: number; scale: number },
) {
  if (typeof root.userData.placedX !== "number") captureViewmodelRest(root);
  root.userData.restX = root.userData.placedX + prefs.x;
  root.userData.restY = root.userData.placedY + prefs.y;
  root.userData.restZ = root.userData.placedZ + prefs.z;
  const base = typeof root.userData.baseScale === "number" ? root.userData.baseScale : root.scale.x || 1;
  root.scale.setScalar(base * prefs.scale);
  root.position.set(root.userData.restX, root.userData.restY, root.userData.restZ);
}

export type ViewmodelMotion = {
  /** Advances with distance travelled, so bob tracks movement not wall time. */
  bobPhase: number;
  swayYaw: number;
  swayPitch: number;
};

export function makeViewmodelMotion(): ViewmodelMotion {
  return { bobPhase: 0, swayYaw: Number.NaN, swayPitch: Number.NaN };
}

const BASE_ROT = new THREE.Euler(-0.05, 0.14, 0.06);

/**
 * Offset the rig from its rest pose: bob from movement, sway from the view
 * turning. Sway is the residual between the live angles and a low-passed copy,
 * so the gun trails the aim and settles when the view stops.
 */
export function animateViewmodel(
  root: THREE.Object3D,
  motion: ViewmodelMotion,
  opts: {
    speed: number;
    yaw: number;
    pitch: number;
    dt: number;
    /** Recoil kick, 1 at the shot decaying to 0. Derived from the tick, so it cannot re-trigger. */
    recoil?: number;
    /** Muzzle flash brightness, 1 at the shot decaying to 0. */
    muzzle?: number;
    /** Shift-walking, which bobs far less than a run at the same speed. */
    walking?: boolean;
  },
) {
  const { speed, yaw, pitch, dt } = opts;
  const recoil = Math.max(0, Math.min(1, opts.recoil ?? 0));
  const muzzle = Math.max(0, Math.min(1, opts.muzzle ?? 0));
  const step = Math.max(0, Math.min(0.25, dt));

  // 250 u/s is about CS running speed.
  const run = Math.max(0, Math.min(1, speed / 250));
  motion.bobPhase += speed * step * 0.045;

  if (!Number.isFinite(motion.swayYaw)) {
    motion.swayYaw = yaw;
    motion.swayPitch = pitch;
  }
  const follow = Math.min(1, step * 9);
  // Shortest-arc so wrapping past 180 does not whip the gun around.
  const dYaw = ((yaw - motion.swayYaw + 540) % 360) - 180;
  motion.swayYaw += dYaw * follow;
  motion.swayPitch += (pitch - motion.swayPitch) * follow;

  const scale = (root.scale.x || 1) * VM_UNITS;
  const amp = run * scale * 0.012 * (opts.walking ? 0.45 : 1);
  const bobY = Math.sin(motion.bobPhase) * amp;
  const bobX = Math.sin(motion.bobPhase / 2) * amp * 0.5;

  // Kick straight back toward the camera and nose-up, scaled with the rig so it
  // holds up at any viewport size.
  root.position.x = (root.userData.restX ?? 0) + bobX;
  root.position.y = (root.userData.restY ?? 0) + bobY - recoil * scale * 0.012;
  root.position.z = (root.userData.restZ ?? -VIEWMODEL_DEPTH) + recoil * scale * 0.05;

  const lagYaw = THREE.MathUtils.clamp(dYaw, -12, 12);
  const lagPitch = THREE.MathUtils.clamp(pitch - motion.swayPitch, -12, 12);
  root.rotation.set(
    BASE_ROT.x + THREE.MathUtils.degToRad(lagPitch) * 0.5 + recoil * 0.16,
    BASE_ROT.y + THREE.MathUtils.degToRad(lagYaw) * 0.5,
    BASE_ROT.z + THREE.MathUtils.degToRad(lagYaw) * 0.2 - recoil * 0.05,
  );

  const flash = root.userData.muzzleFlash as THREE.Sprite | undefined;
  if (flash) {
    flash.visible = muzzle > 0;
    (flash.material as THREE.SpriteMaterial).opacity = muzzle;
    const size = 3.2 * (0.75 + 0.4 * (1 - muzzle));
    flash.scale.set(size, size, 1);
  }
}
