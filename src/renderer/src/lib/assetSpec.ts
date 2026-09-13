/**
 * Turns a clip dump into the exact list of models and animations to export.
 *
 * This lives in the renderer because the weapon table does, and CS2's animation
 * names cannot be derived from a weapon id — they have to be looked up. Core
 * takes the list verbatim and reports anything it did not recognise.
 *
 * Keeping the list tight matters: an unfiltered agent export is 1.07 GB, and
 * cost scales with the number of animations, so only the weapon categories that
 * actually appear in the clip contribute locomotion, and only the POV player's
 * weapons contribute first-person poses.
 */

import type { PreviewDump } from "./clipPlayback";
import { allWeaponModels, allWeapons, casingModel, nadeWeaponFromKind, resolveWeapon, type WeaponInfo, type WorldCategory } from "./weaponTable";

export const DIRECTIONS = ["n", "ne", "e", "se", "s", "sw", "w", "nw"] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** Agent identity is not in the demo, so each side gets a fixed default. */
export const AGENT_BY_TEAM: Record<string, string> = { CT: "ctm_sas", T: "tm_phoenix" };
export const FALLBACK_AGENT = "ctm_sas";

export type AssetSpec = {
  /** Paths under `weapons/models`, no extension. */
  weapons: string[];
  /** Agent name to the animations that agent must carry. */
  agents: Record<string, string[]>;
  /** Paint kits that appear in the clip (`{weapon, skin, paintKit}`). */
  skins: SkinRequest[];
  warm?: boolean;
};

export type SkinRequest = {
  weapon: string;
  skin: string;
  paintKit: number;
};

export function skinKey(weapon: string, skin?: string | null, paintKit?: number | null): string {
  const paint = Number(paintKit || 0);
  if (paint > 0) return String(Math.trunc(paint));
  const slug = String(skin ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  if (slug && slug !== "default" && slug !== "vanilla" && slug !== "none") return slug;
  return "";
}

export function collectSkinRequests(dump: PreviewDump): SkinRequest[] {
  const seen = new Map<string, SkinRequest>();
  for (const frame of dump.frames ?? []) {
    for (const pose of Object.values(frame.players ?? {})) {
      const weapon = pose.weapon ?? "";
      const info = resolveWeapon(weapon);
      if (!info.model || info.kind === "nade" || info.kind === "c4" || info.kind === "equipment") continue;
      const key = skinKey(weapon, pose.skin, pose.paintKit);
      if (!key || seen.has(key)) continue;
      seen.set(key, { weapon, skin: pose.skin ?? "", paintKit: Number(pose.paintKit || 0) });
    }
  }
  return [...seen.values()];
}

export function viewmodelAnim(poseSet: string, name: string): string {
  return `animation/anims/viewmodel/${poseSet}/${name}`;
}

export function worldAnim(category: WorldCategory, name: string): string {
  return `animation/anims/world/${category}/_default_${category}/${name}`;
}

export function sharedAnim(name: string): string {
  return `animation/anims/world/shared/${name}`;
}

/** Locomotion for one weapon category: idles plus 8 directions of each gait. */
export function locomotionAnims(category: WorldCategory): string[] {
  const out = [worldAnim(category, `idle_${category}`), worldAnim(category, `idle_crouch_${category}`)];
  for (const dir of DIRECTIONS) {
    out.push(worldAnim(category, `run_${dir}_${category}`));
    out.push(worldAnim(category, `walk_${dir}_${category}`));
    out.push(worldAnim(category, `crouch_${dir}_${category}`));
  }
  return out;
}

/** Layered on top of locomotion; these are delta tracks, hence compose_additive. */
export const SHARED_ANIMS = [
  sharedAnim("breathing"),
  sharedAnim("jump_additive_start"),
  sharedAnim("jump_additive_land"),
];

/** The first-person poses one weapon needs. Absent verbs are skipped. */
export function viewmodelAnims(info: WeaponInfo): string[] {
  const { poses, poseSet } = info;
  const names = [poses.idle, poses.draw, poses.shoot, poses.reload].filter(
    (name): name is string => Boolean(name),
  );
  return names.map((name) => viewmodelAnim(poseSet, name));
}

function collectWeaponNames(dump: PreviewDump): string[] {
  const names = new Set<string>();
  for (const frame of dump.frames ?? []) {
    for (const pose of Object.values(frame.players ?? {})) {
      if (pose.weapon) names.add(pose.weapon);
    }
  }
  for (const shot of dump.shots ?? []) {
    if (shot.weapon) names.add(shot.weapon);
  }
  for (const equip of dump.equips ?? []) {
    if (equip.item) names.add(equip.item);
  }
  if ((dump.bombs ?? []).length) names.add("c4");
  for (const nade of dump.grenades ?? []) {
    if (nade.kind) names.add(nadeWeaponFromKind(nade.kind));
  }
  return [...names];
}

function povWeaponNames(dump: PreviewDump): string[] {
  const pov = dump.povSteamid;
  const names = new Set<string>();
  for (const frame of dump.frames ?? []) {
    const pose = frame.players?.[pov];
    if (pose?.weapon) names.add(pose.weapon);
  }
  for (const equip of dump.equips ?? []) {
    if (equip.steamid === pov && equip.item) names.add(equip.item);
  }
  return [...names];
}

function teamsPresent(dump: PreviewDump): string[] {
  const teams = new Set<string>();
  for (const frame of dump.frames ?? []) {
    for (const pose of Object.values(frame.players ?? {})) {
      if (pose.team) teams.add(pose.team);
    }
  }
  return [...teams];
}

function povTeam(dump: PreviewDump): string {
  for (const frame of dump.frames ?? []) {
    const pose = frame.players?.[dump.povSteamid];
    if (pose?.team) return pose.team;
  }
  return "CT";
}

/**
 * First wave: the viewed player's current gun and the poses those hands need.
 * Enemy locomotion and casing meshes wait for the full spec so arms can appear
 * without waiting on Source2Viewer for every category in the clip.
 */
export function buildPriorityAssetSpec(dump: PreviewDump): AssetSpec {
  const pov = dump.povSteamid;
  const start = dump.frames?.[0]?.players?.[pov];
  const info = resolveWeapon(start?.weapon ?? "");
  const weapons = info.model ? [info.model] : [];
  const team = start?.team || povTeam(dump);
  const agent = AGENT_BY_TEAM[team] ?? FALLBACK_AGENT;
  const firstPerson = viewmodelAnims(info);
  if (!weapons.length && !firstPerson.length) return { weapons: [], agents: {}, skins: [] };
  const agents: Record<string, string[]> = {};
  if (firstPerson.length) {
    const poses = [...new Set(firstPerson)].sort();
    agents[agent] = poses;
    // T agents often ship no viewmodel clips; SAS always does, and the arms
    // loader falls back to it when the team skeleton has no idle pose.
    if (agent !== FALLBACK_AGENT) agents[FALLBACK_AGENT] = poses;
  }
  const painted = skinKey(start?.weapon ?? "", start?.skin, start?.paintKit);
  const skins =
    painted && info.model
      ? [{ weapon: start?.weapon ?? "", skin: start?.skin ?? "", paintKit: Number(start?.paintKit || 0) }]
      : [];
  return {
    weapons: weapons.sort(),
    agents,
    skins,
  };
}

export function buildAssetSpec(dump: PreviewDump): AssetSpec {
  const all = collectWeaponNames(dump).map(resolveWeapon);

  const models = new Set<string>();
  for (const info of all) {
    if (info.model) models.add(info.model);
    const casing = casingModel(info);
    if (casing) models.add(casing);
  }

  const categories = new Set<WorldCategory>();
  for (const info of all) categories.add(info.world);
  // A clip with no recognised weapon still needs someone to stand around.
  if (categories.size === 0) categories.add("rifle");

  const world = [...categories].flatMap(locomotionAnims).concat(SHARED_ANIMS);

  const firstPerson = new Set<string>();
  for (const info of povWeaponNames(dump).map(resolveWeapon)) {
    for (const name of viewmodelAnims(info)) firstPerson.add(name);
  }

  const teams = teamsPresent(dump);
  const agents: Record<string, string[]> = {};
  const povAgent = AGENT_BY_TEAM[povTeam(dump)] ?? FALLBACK_AGENT;
  for (const team of teams.length ? teams : ["CT"]) {
    const agent = AGENT_BY_TEAM[team] ?? FALLBACK_AGENT;
    const anims = new Set<string>(world);
    // First-person poses live on the viewed player's agent. SAS also gets
    // them so a T POV can fall back when phoenix has no viewmodel clips.
    if (agent === povAgent || agent === FALLBACK_AGENT) {
      for (const name of firstPerson) anims.add(name);
    }
    agents[agent] = [...(agents[agent] ?? []), ...anims];
  }
  for (const agent of Object.keys(agents)) agents[agent] = [...new Set(agents[agent])].sort();

  return { weapons: [...models].sort(), agents, skins: collectSkinRequests(dump) };
}

/**
 * Prefetch every gun mesh plus SAS/Phoenix locomotion (no 4K materials).
 *
 * T agents often ship no viewmodel clips; SAS still gets every idle so a T POV
 * can fall back to it, same as a live clip.
 */
export function buildWarmAssetSpec(): AssetSpec {
  const models = allWeaponModels();
  const world = (["rifle", "pistol", "knife"] as WorldCategory[]).flatMap(locomotionAnims).concat(SHARED_ANIMS);
  const idles = new Set<string>();
  for (const info of allWeapons()) {
    if (info.poses.idle) idles.add(viewmodelAnim(info.poseSet, info.poses.idle));
  }
  const sas = [...new Set([...world, ...idles])].sort();
  return {
    weapons: models,
    agents: {
      [FALLBACK_AGENT]: sas,
      [AGENT_BY_TEAM.T]: [...world].sort(),
    },
    skins: [],
    warm: true,
  };
}
