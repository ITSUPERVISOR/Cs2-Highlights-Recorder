import * as THREE from "three";
import { resolveWeapon, weaponKind } from "./weaponTable";

export function teamColor(team: string) {
  if (team === "CT") return 0x5eb1ef;
  if (team === "T") return 0xf0a12a;
  return 0x8a8e9a;
}

export type { WeaponKind } from "./weaponTable";
export { weaponKind };

/** Canonical id, resolving display names as well as `weapon_` ids. */
function normalizeWeapon(weapon: string) {
  return resolveWeapon(weapon).id;
}

const GUN = 0x2a2d33;
const GRIP = 0x1a1c20;
const STOCK = 0x3a3f46;
const BLADE = 0xc5c8ce;
const NADES: Record<string, number> = {
  hegrenade: 0x6b8f3a,
  flashbang: 0xd8d4c4,
  smokegrenade: 0x8a8e9a,
  molotov: 0xc45c26,
  incgrenade: 0xc45c26,
  decoy: 0x9aa0a8,
};

function posterize(hex: number, bits = 5) {
  const levels = (1 << bits) - 1;
  const quant = (channel: number) => Math.round((Math.round((channel / 255) * levels) / levels) * 255);
  return (quant((hex >> 16) & 255) << 16) | (quant((hex >> 8) & 255) << 8) | quant(hex & 255);
}

function gunMat(color: number) {
  return new THREE.MeshLambertMaterial({ color: posterize(color), flatShading: true });
}

export function makeWeaponMesh(weapon: string): THREE.Group {
  const kind = weaponKind(weapon);
  const g = new THREE.Group();
  g.name = "weapon";
  g.userData.kind = kind;
  g.userData.weapon = normalizeWeapon(weapon);

  if (kind === "knife") {
    g.add(mesh(new THREE.BoxGeometry(2, 1.4, 14), gunMat(BLADE), 0, 0, -8));
    g.add(mesh(new THREE.BoxGeometry(2.2, 2.2, 6), gunMat(GRIP), 0, 0, 2));
    return g;
  }
  if (kind === "nade") {
    const color = NADES[normalizeWeapon(weapon)] ?? 0x6b8f3a;
    g.add(mesh(new THREE.SphereGeometry(3.2, 10, 8), gunMat(color), 0, 0, -2));
    return g;
  }
  if (kind === "c4" || kind === "equipment") {
    g.add(mesh(new THREE.BoxGeometry(10, 4, 8), gunMat(0x4a3a28), 0, 0, -4));
    return g;
  }
  if (kind === "taser") {
    g.add(mesh(new THREE.BoxGeometry(3, 5, 10), gunMat(0xf0c14a), 0, 0, -4));
    return g;
  }

  const length = kind === "sniper" ? 52 : kind === "rifle" ? 38 : kind === "shotgun" ? 34 : kind === "smg" ? 26 : 16;
  const barrel = kind === "pistol" ? 10 : kind === "sniper" ? 28 : 18;
  g.add(mesh(new THREE.BoxGeometry(2.4, 3.2, length * 0.45), gunMat(GUN), 0, 0, -length * 0.22));
  g.add(mesh(new THREE.CylinderGeometry(0.9, 0.9, barrel, 8), gunMat(STOCK), 0, 0.4, -length * 0.45));
  const mag = g.children[g.children.length - 1] as THREE.Mesh;
  mag.rotation.x = Math.PI / 2;
  g.add(mesh(new THREE.BoxGeometry(2.2, 8, 4), gunMat(GRIP), 0, -5, 2));
  if (kind !== "pistol") {
    g.add(mesh(new THREE.BoxGeometry(1.6, 3.5, 10), gunMat(STOCK), 0, 1, 8));
  }
  if (kind === "sniper") {
    g.add(mesh(new THREE.CylinderGeometry(1.4, 1.4, 8, 8), gunMat(0x1c1e22), 0, 3.2, -8));
    (g.children[g.children.length - 1] as THREE.Mesh).rotation.x = Math.PI / 2;
  }
  return g;
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = false;
  return m;
}

/** Where the held weapon sits relative to the chest, in rig-local units. */
const WEAPON_POS = new THREE.Vector3(4, 30, -13);
const WEAPON_ROT = new THREE.Euler(0, 0.06, -0.1);

type RigParts = {
  /** Tips over on death; carries everything so the whole body falls. */
  body: THREE.Group;
  /** Legs and pelvis. Stays level so walking reads even while aiming. */
  lower: THREE.Group;
  /** Chest up. Pitches with the aim. */
  upper: THREE.Group;
  legL: THREE.Object3D;
  legR: THREE.Object3D;
  weapon: THREE.Group;
};

/**
 * Blocky player, grouped so the upper body can aim independently of the legs.
 *
 * -Z is forward throughout, matching the weapon meshes and the viewmodel.
 */
export function makePlayerRig(team: string): THREE.Group {
  const color = teamColor(team);
  const cloth = gunMat(color);
  const dark = gunMat(0x1c1f24);
  const skin = gunMat(0xc4a07a);
  const vest = gunMat(0x24272d);

  const root = new THREE.Group();
  root.name = "player";
  root.userData.team = team;

  const body = new THREE.Group();
  body.name = "body";
  const lower = new THREE.Group();
  lower.name = "lower";
  const upper = new THREE.Group();
  upper.name = "upper";

  lower.add(mesh(new THREE.BoxGeometry(16, 8, 10), dark, 0, 16, 0));
  // Hips at y=18 so a swing about the group origin reads as a stride.
  const legL = new THREE.Group();
  legL.position.set(-5, 18, 0);
  legL.add(mesh(new THREE.CapsuleGeometry(3.6, 15, 3, 6), dark, 0, -9, 0));
  const legR = new THREE.Group();
  legR.position.set(5, 18, 0);
  legR.add(mesh(new THREE.CapsuleGeometry(3.6, 15, 3, 6), dark, 0, -9, 0));
  lower.add(legL, legR);

  upper.add(mesh(new THREE.BoxGeometry(18, 22, 11), cloth, 0, 32, 0));
  upper.add(mesh(new THREE.BoxGeometry(19, 13, 12.4), vest, 0, 34, 0));
  upper.add(mesh(new THREE.SphereGeometry(7.2, 12, 10), skin, 0, 50, 0));
  const helmet = mesh(new THREE.SphereGeometry(7.6, 12, 10), cloth, 0, 51, 0);
  helmet.scale.set(1, 0.72, 1);
  upper.add(helmet);
  upper.add(mesh(new THREE.BoxGeometry(10, 3.2, 2.4), dark, 0, 50, -6.4));

  // Both hands on the weapon rather than one arm out to the side.
  const armR = arm(cloth, skin);
  armR.position.set(7, 34, -2);
  armR.rotation.set(-0.55, -0.22, 0);
  const armL = arm(cloth, skin);
  armL.position.set(-6, 33, -3);
  armL.rotation.set(-0.95, 0.3, 0);
  upper.add(armR, armL);

  const weapon = makeWeaponMesh("ak47");
  weapon.position.copy(WEAPON_POS);
  weapon.rotation.copy(WEAPON_ROT);
  upper.add(weapon);

  body.add(lower, upper);
  root.add(body);

  const parts: RigParts = { body, lower, upper, legL, legR, weapon };
  root.userData.parts = parts;
  root.userData.weapon = weapon;
  root.userData.phase = 0;
  return root;
}

/** Upper arm plus forearm reaching forward to the weapon, with a fist. */
function arm(cloth: THREE.Material, skin: THREE.Material) {
  const g = new THREE.Group();
  const limb = mesh(new THREE.CapsuleGeometry(3, 13, 3, 6), cloth, 0, 0, -6.5);
  limb.rotation.x = Math.PI / 2;
  g.add(limb);
  g.add(mesh(new THREE.SphereGeometry(2.6, 8, 6), skin, 0, 0, -14));
  return g;
}

function parts(rig: THREE.Group): RigParts | null {
  return (rig.userData.parts as RigParts | undefined) ?? null;
}

export function setRigWeapon(rig: THREE.Group, weapon: string) {
  const p = parts(rig);
  if (!p) return;
  const current = rig.userData.weapon as THREE.Group | undefined;
  const nextKind = weaponKind(weapon);
  if (current && current.userData.kind === nextKind && current.userData.weapon === normalizeWeapon(weapon)) return;
  if (current) {
    p.upper.remove(current);
    current.traverse((child) => {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      const mat = mesh.material;
      if (!mat) return;
      const list = Array.isArray(mat) ? mat : [mat];
      for (const item of list) item.dispose();
    });
  }
  const next = makeWeaponMesh(weapon);
  next.position.copy(WEAPON_POS);
  next.rotation.copy(WEAPON_ROT);
  p.upper.add(next);
  rig.userData.weapon = next;
}

/**
 * Pitch the upper body toward the aim. Damped and clamped, because a body bent
 * to a full 89 degrees of look-down snaps in half.
 */
export function aimRig(rig: THREE.Group, pitchDeg: number) {
  const p = parts(rig);
  if (!p) return;
  const damped = THREE.MathUtils.clamp(pitchDeg * 0.55, -35, 35);
  p.upper.rotation.x = -THREE.MathUtils.degToRad(damped);
}

/**
 * Crouch by dropping the chest and compressing the legs, never by squashing.
 *
 * Takes the crouch amount rather than a boolean so the pose eases through the
 * transition instead of snapping between standing and crouched.
 */
export function setRigDucking(rig: THREE.Group, duck: number) {
  const p = parts(rig);
  if (!p) return;
  const amount = THREE.MathUtils.clamp(duck, 0, 1);
  p.upper.position.y = -13 * amount;
  p.lower.scale.y = 1 - 0.38 * amount;
}

/** Lay dead players out on the ground so they are obvious at a glance. */
export function setRigDead(rig: THREE.Group, dead: boolean, deathAge = 10) {
  const p = parts(rig);
  if (!p) return;
  const t = dead ? Math.min(1, Math.max(0, deathAge / 0.45)) : 0;
  const e = t * t * (3 - 2 * t);
  p.body.rotation.x = -1.35 * e;
  p.body.position.y = 4 * e;
  const gun = (rig.userData.weapon as THREE.Group | undefined) ?? p.weapon;
  if (gun) gun.visible = !dead || deathAge < 0.15;
}

/**
 * Stride the legs from ground speed. Phase accumulates on the rig from distance
 * travelled, so the cycle stays in step with movement while scrubbing.
 */
export function animateRig(rig: THREE.Group, speed: number, dt: number) {
  const p = parts(rig);
  if (!p) return;
  const step = Math.max(0, Math.min(0.25, dt));
  const phase = ((rig.userData.phase as number) ?? 0) + speed * step * 0.05;
  rig.userData.phase = phase;
  // 250 u/s is about CS running speed.
  const run = Math.max(0, Math.min(1, speed / 250));
  const swing = Math.sin(phase) * run * 0.6;
  p.legL.rotation.x = swing;
  p.legR.rotation.x = -swing;
  p.lower.position.y = Math.abs(Math.sin(phase)) * run * 1.5;
}
