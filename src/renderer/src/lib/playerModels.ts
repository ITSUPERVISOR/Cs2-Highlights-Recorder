/**
 * Real third-person agents, walking and aiming from the clip.
 *
 * The same agent GLB that supplies the first-person arms also carries
 * `thirdperson_body` plus the world locomotion set: 8-direction walk/run, idle,
 * crouch, and a few additives. Those world clips have real motion (run is 23
 * keys over 0.73s), so they go through an AnimationMixer. Time is assigned from
 * the clip tick, never from wall time, so scrubbing stays in step.
 *
 * Geometry and clips are shared across instances of the same agent. Each player
 * still gets its own skeleton clone, otherwise ten Ts would snap to one pose.
 */

import * as THREE from "three";
import { applyAgentMaterials } from "./assetMaterials";
import { AGENT_BY_TEAM, FALLBACK_AGENT, type Direction } from "./assetSpec";
import {
  bundleAgentPath,
  collectBones,
  findClip,
  instantiate,
  loadAsset,
  METRES_TO_INCHES,
  type AssetBundle,
} from "./gameAssets";
import { hideMesh, PLACEHOLDER_MESH } from "./armsViewmodel";
import {
  attachWeapon,
  disposeWeaponModel,
  makeWeaponModel,
  updateWeaponModel,
  type WeaponModel,
} from "./weaponModels";
import { resolveWeapon, type WeaponInfo, type WorldCategory } from "./weaponTable";

export const ARMS_MESH = "firstperson_default_gloves_arms";
export const SLEEVES_MESH = "firstperson_sleeves";

const DEATH_FALL = 0.45;
const DEATH_HIDE_GUN = 0.15;
const DEATH_TIP = -1.35;
const DEATH_SINK = 4 / METRES_TO_INCHES;

function smoothstep(t: number) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

export function deathFallAmount(deathAge: number | null | undefined) {
  return smoothstep((deathAge ?? 10) / DEATH_FALL);
}

const WALK_SPEED = 130;
const RUN_SPEED = 210;
const IDLE_SPEED = 28;

export type PlayerModel = {
  root: THREE.Group;
  model: THREE.Group;
  bones: Map<string, THREE.Object3D>;
  wpnBone: THREE.Object3D | null;
  mixer: THREE.AnimationMixer;
  clips: THREE.AnimationClip[];
  weapon: WeaponModel | null;
  weaponId: string;
  weaponSkin: string;
  team: string;
  agent: string;
  /** Accumulated stride in seconds, so the gait stays continuous while playing. */
  phase: number;
  active: THREE.AnimationAction[];
};

function clipName(category: WorldCategory, verb: string, dir?: Direction) {
  if (dir) return `${verb}_${dir}_${category}`;
  return `${verb}_${category}`;
}

/**
 * Heading of movement relative to aim, in degrees.
 *
 * 0 is forward, +90 is left (Source yaw is counter-clockwise), -90 is right.
 */
export function relativeHeading(velX: number, velY: number, yaw: number) {
  if (velX * velX + velY * velY < 1) return 0;
  const moveYaw = (Math.atan2(velY, velX) * 180) / Math.PI;
  return ((moveYaw - yaw + 540) % 360) - 180;
}

export function nearestDirection(rel: number): Direction {
  const wrapped = ((rel % 360) + 360) % 360;
  const idx = Math.round(wrapped / 45) % 8;
  // 0 = forward (n), then CCW: nw, w, sw, s, se, e, ne. Source left is +yaw.
  const order: Direction[] = ["n", "nw", "w", "sw", "s", "se", "e", "ne"];
  return order[idx] ?? "n";
}

export async function makePlayerModel(
  bundle: AssetBundle | null,
  team: string,
): Promise<PlayerModel | null> {
  const agent = AGENT_BY_TEAM[team] ?? FALLBACK_AGENT;
  const path = bundleAgentPath(bundle, agent);
  if (!path) return null;
  const loaded = await loadAsset(path);
  if (!loaded) return null;

  const { root, model, animations } = instantiate(loaded, { flipForward: false });
  // Agents are authored +Z forward; ClipStage writes -Z body yaw onto `root`
  // every frame, which would wipe a flip there. Turn the inner model instead.
  model.rotation.y = Math.PI;
  root.name = `player:${agent}`;
  applyAgentMaterials(model, team);
  hideMesh(model, ARMS_MESH);
  hideMesh(model, SLEEVES_MESH);
  hideMesh(model, PLACEHOLDER_MESH);

  const bones = collectBones(model);
  const mixer = new THREE.AnimationMixer(model);
  for (const clip of animations) {
    const action = mixer.clipAction(clip);
    action.enabled = false;
    action.paused = true;
    action.play();
  }

  return {
    root,
    model,
    bones,
    wpnBone: bones.get("wpn") ?? bones.get("wpnPivot") ?? bones.get("hand_R") ?? null,
    mixer,
    clips: animations,
    weapon: null,
    weaponId: "",
    weaponSkin: "",
    team,
    agent,
    phase: 0,
    active: [],
  };
}

export async function setPlayerWeapon(
  player: PlayerModel,
  bundle: AssetBundle | null,
  weapon: string,
  skinKey = "",
) {
  const info = resolveWeapon(weapon);
  if (player.weaponId === info.id && player.weaponSkin === skinKey && player.weapon) return;
  if (player.weapon) {
    player.weapon.root.removeFromParent();
    disposeWeaponModel(player.weapon);
    player.weapon = null;
  }
  player.weaponId = info.id;
  player.weaponSkin = skinKey;
  // World clips park the rifle on `wpn`. Align the weapon bone to that, not
  // the grip helper: `ag1` → `wpn` leaves the receiver floating above the
  // right hand after the inner 180° facing flip.
  const attach = player.wpnBone ?? player.bones.get("hand_R");
  const model = await makeWeaponModel(bundle, info, { attached: Boolean(attach), skinKey });
  if (!model) return;
  if (attach) attachWeapon(model, attach, "weapon");
  else player.model.add(model.root);
  player.weapon = model;
}

function enableClip(
  player: PlayerModel,
  name: string | null,
  time: number,
  weight: number,
) {
  if (!name || weight <= 0) return;
  const clip = findClip(player.clips, name);
  if (!clip) return;
  const action = player.mixer.clipAction(clip);
  action.enabled = true;
  action.paused = true;
  action.setEffectiveWeight(weight);
  const duration = Math.max(clip.duration, 1e-4);
  action.time = ((time % duration) + duration) % duration;
  player.active.push(action);
}

function clearActions(player: PlayerModel) {
  for (const action of player.active) {
    action.enabled = false;
    action.setEffectiveWeight(0);
  }
  player.active = [];
}

/**
 * Pose this player for the current tick.
 *
 * Locomotion is a single nearest-direction clip rather than an 8-way blend: the
 * clips already cover every compass point, and blending eight skinned meshes on
 * ten players is the first thing that would drop the frame rate.
 */
export function updatePlayerModel(
  player: PlayerModel,
  opts: {
    tick: number;
    tickrate: number;
    dt: number;
    yaw: number;
    pitch: number;
    duck: number;
    alive: boolean;
    /** Seconds since they died; null while alive. Drives the tip-over ease. */
    deathAge?: number | null;
    walking?: boolean;
    velX: number;
    velY: number;
    shotAge?: number | null;
    reload?: number | null;
    info?: WeaponInfo;
  },
) {
  const category = opts.info?.world ?? "rifle";
  const speed = Math.hypot(opts.velX, opts.velY);
  const duck = Math.min(1, Math.max(0, opts.duck));
  const rel = relativeHeading(opts.velX, opts.velY, opts.yaw);
  const dir = nearestDirection(rel);

  const step = Math.max(0, Math.min(0.25, opts.dt));
  player.phase += (speed / Math.max(WALK_SPEED, 1)) * step;

  clearActions(player);

  if (!opts.alive) {
    enableClip(player, clipName(category, "idle"), 0, 1);
    player.mixer.update(0);
    unwindSpineLean(player);
    const fall = deathFallAmount(opts.deathAge);
    // Tip the inner model, not the root: ClipStage writes world yaw onto the
    // root every frame, which is what left corpses standing like they went AFK.
    player.model.rotation.x = DEATH_TIP * fall;
    player.model.rotation.y = Math.PI;
    player.model.position.y = DEATH_SINK * fall;
    if (player.weapon) player.weapon.root.visible = (opts.deathAge ?? 10) < DEATH_HIDE_GUN;
    return;
  }
  player.model.rotation.x = 0;
  player.model.rotation.y = Math.PI;
  player.model.position.y = 0;
  if (player.weapon) player.weapon.root.visible = true;

  const crouched = duck > 0.45;
  if (speed < IDLE_SPEED) {
    enableClip(player, clipName(category, crouched ? "idle_crouch" : "idle"), player.phase * 0.15, 1);
    const breathe = findClip(player.clips, "breathing");
    if (breathe && !crouched) enableClip(player, "breathing", opts.tick / Math.max(opts.tickrate, 1), 0.35);
  } else {
    const running = !opts.walking && speed >= RUN_SPEED;
    const verb = crouched ? "crouch" : running ? "run" : "walk";
    enableClip(player, clipName(category, verb, dir), player.phase * (running ? 0.85 : 0.7), 1);
  }

  player.mixer.update(0);

  if (player.weapon) {
    updateWeaponModel(player.weapon, { shotAge: opts.shotAge ?? null, reload: opts.reload ?? null });
  }

  applySpineLean(player, opts.pitch);
}

function spineBone(player: PlayerModel) {
  return player.bones.get("spine_3") ?? player.bones.get("spine_2") ?? null;
}

function unwindSpineLean(player: PlayerModel) {
  const spine = spineBone(player);
  if (!spine) return;
  const prev = typeof spine.userData.leanX === "number" ? spine.userData.leanX : 0;
  if (prev) spine.rotation.x -= prev;
  spine.userData.leanX = 0;
}

/**
 * A little aim lean on the spine, never the full pitch — same reason the
 * blocky rig clamps it: 89 degrees of look-down snaps a body in half.
 *
 * Walk clips often leave `spine_3` unkeyed, so adding lean every tick without
 * undoing the last one winds the torso into a spin.
 */
function applySpineLean(player: PlayerModel, pitchDeg: number) {
  const spine = spineBone(player);
  if (!spine) return;
  unwindSpineLean(player);
  const lean = THREE.MathUtils.clamp(pitchDeg * 0.35, -28, 28);
  const add = -THREE.MathUtils.degToRad(lean);
  spine.rotation.x += add;
  spine.userData.leanX = add;
}

export function disposePlayerModel(player: PlayerModel | null) {
  if (!player) return;
  clearActions(player);
  player.mixer.stopAllAction();
  disposeWeaponModel(player.weapon);
  player.root.removeFromParent();
}
