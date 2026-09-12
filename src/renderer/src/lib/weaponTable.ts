/**
 * Canonical weapon identities, model paths and CS2 animation names.
 *
 * Two problems this solves.
 *
 * First, the demo names the same gun two different ways: poses carry *display*
 * names (`Desert Eagle`, `SSG 08`, `M4A1-S`) while `weapon_fire` carries ids
 * (`weapon_deagle`, `weapon_ssg08`). Both are normalised to one key here.
 *
 * Second, CS2's animation names are irregular enough that they cannot be
 * derived. `pistol_glock18` holds `idle_glock`, `rifle_g3sg1` and `rifle_m249`
 * use `idle1_`, `grenade_smokegrenade` uses `idle_smoke`, and `pistol_elite`
 * has no shoot pose at all. A wrong name is silent — the exporter just prints
 * "matched no animations" and the hand ends up unposed — so every name below
 * was read out of the local install rather than guessed.
 */

export type WeaponKind = "rifle" | "sniper" | "smg" | "shotgun" | "pistol" | "knife" | "nade" | "c4" | "taser" | "equipment";

/** Third-person locomotion sets. Only these three exist; grenades borrow one. */
export type WorldCategory = "rifle" | "pistol" | "knife";

export type WeaponPoses = {
  idle: string;
  /** Null where CS2 ships no shoot pose (knives, c4, dual Berettas). */
  shoot: string | null;
  reload: string | null;
  draw: string;
};

export type WeaponInfo = {
  id: string;
  kind: WeaponKind;
  /** Path under `weapons/models/`, no extension. Null when nothing to export. */
  model: string | null;
  /** Viewmodel pose set, e.g. `rifle/rifle_ak`. */
  poseSet: string;
  poses: WeaponPoses;
  world: WorldCategory;
  /** Casing family under `weapons/models/shared/shells/`, or null. */
  casing: string | null;
  silenced: boolean;
};

/** Most sets follow `<verb>_<suffix>`; overrides carry the ones that do not. */
function poses(suffix: string, over: Partial<WeaponPoses> = {}): WeaponPoses {
  return {
    idle: over.idle ?? `idle_${suffix}`,
    shoot: over.shoot !== undefined ? over.shoot : `shoot1_${suffix}`,
    reload: over.reload !== undefined ? over.reload : `reload_${suffix}`,
    draw: over.draw ?? `draw_${suffix}`,
  };
}

type Spec = Omit<WeaponInfo, "poses"> & { poses: WeaponPoses };

function gun(
  id: string,
  kind: WeaponKind,
  model: string,
  poseSet: string,
  suffix: string,
  casing: string | null,
  extra: { over?: Partial<WeaponPoses>; world?: WorldCategory; silenced?: boolean } = {},
): Spec {
  return {
    id,
    kind,
    model,
    poseSet,
    poses: poses(suffix, extra.over),
    world: extra.world ?? (kind === "pistol" || kind === "taser" ? "pistol" : "rifle"),
    casing,
    silenced: extra.silenced ?? false,
  };
}

function knife(id: string, folder: string, suffix: string, idle: string): Spec {
  return {
    id,
    kind: "knife",
    model: `knife/${folder}/weapon_knife_${folder.replace(/^knife_/, "")}`,
    poseSet: `knife/${folder}`,
    poses: poses(suffix, { idle, shoot: null, reload: null }),
    world: "knife",
    casing: null,
    silenced: false,
  };
}

function nade(id: string, model: string, poseSet: string, suffix: string): Spec {
  return {
    id,
    kind: "nade",
    model,
    poseSet,
    // Grenades have no shoot pose; the overhand throw is the closest analogue.
    poses: poses(suffix, { shoot: `throw_overhand_${suffix}`, reload: null }),
    // The grenade world set carries only idles, so locomotion comes from pistol.
    world: "pistol",
    casing: null,
    silenced: false,
  };
}

const SPECS: Spec[] = [
  // Rifles.
  gun("ak47", "rifle", "ak47/weapon_rif_ak47", "rifle/rifle_ak", "ak", "ak47"),
  gun("m4a4", "rifle", "m4a4/weapon_rif_m4a4", "rifle/rifle_m4a4", "m4a4", "ak47"),
  // No rifle_m4a1 set exists; the silenced M4 shares the M4A4 poses.
  gun("m4a1_silencer", "rifle", "m4a1_silencer/weapon_rif_m4a1_silencer", "rifle/rifle_m4a4", "m4a4", "ak47", {
    silenced: true,
  }),
  gun("galilar", "rifle", "galilar/weapon_rif_galilar", "rifle/rifle_galilar", "galilar", "ak47"),
  gun("famas", "rifle", "famas/weapon_rif_famas", "rifle/rifle_famas", "famas", "ak47"),
  gun("aug", "rifle", "aug/weapon_rif_aug", "rifle/rifle_aug", "aug", "ak47"),
  gun("sg556", "rifle", "sg556/weapon_rif_sg556", "rifle/rifle_sg556", "sg556", "ak47"),

  // Snipers.
  gun("awp", "sniper", "awp/weapon_snip_awp", "rifle/rifle_awp", "awp", "awp"),
  gun("ssg08", "sniper", "ssg08/weapon_snip_ssg08", "rifle/rifle_ssg08", "ssg08", "awp"),
  gun("scar20", "sniper", "scar20/weapon_snip_scar20", "rifle/rifle_scar20", "scar20", "awp"),
  gun("g3sg1", "sniper", "g3sg1/weapon_snip_g3sg1", "rifle/rifle_g3sg1", "g3sg1", "awp", {
    over: { idle: "idle1_g3sg1" },
  }),

  // SMGs.
  gun("mac10", "smg", "mac10/weapon_smg_mac10", "rifle/rifle_mac10", "mac10", "glock"),
  gun("mp9", "smg", "mp9/weapon_smg_mp9", "rifle/rifle_mp9", "mp9", "glock"),
  gun("mp7", "smg", "mp7/weapon_smg_mp7", "rifle/rifle_mp7", "mp7", "glock"),
  gun("mp5sd", "smg", "mp5sd/weapon_smg_mp5sd", "rifle/rifle_mp5sd", "mp5sd", "glock", { silenced: true }),
  gun("ump45", "smg", "ump45/weapon_smg_ump45", "rifle/rifle_ump45", "ump45", "glock"),
  gun("p90", "smg", "p90/weapon_smg_p90", "rifle/rifle_p90", "p90", "p90"),
  gun("bizon", "smg", "bizon/weapon_smg_bizon", "rifle/rifle_bizon", "bizon", "glock"),

  // Shotguns.
  gun("nova", "shotgun", "nova/weapon_shot_nova", "rifle/rifle_nova", "nova", "shotgun/nova"),
  gun("xm1014", "shotgun", "xm1014/weapon_shot_xm1014", "rifle/rifle_xm1014", "xm1014", "shotgun/xm1014"),
  gun("mag7", "shotgun", "mag7/weapon_shot_mag7", "rifle/rifle_mag7", "mag7", "shotgun/mag7"),
  gun("sawedoff", "shotgun", "sawedoff/weapon_shot_sawedoff", "rifle/rifle_sawedoff", "sawedoff", "shotgun/nova"),

  // Machine guns. Both carry idle1_ rather than idle_.
  gun("m249", "rifle", "m249/weapon_mach_m249", "rifle/rifle_m249", "m249", "ak47", {
    over: { idle: "idle1_m249" },
  }),
  gun("negev", "rifle", "negev/weapon_mach_negev", "rifle/rifle_negev", "negev", "ak47"),

  // Pistols.
  gun("glock18", "pistol", "glock18/weapon_pist_glock18", "pistol/pistol_glock18", "glock", "glock"),
  // No pistol_usp set; the USP-S shares the P2000 frame and its poses.
  gun("usp_silencer", "pistol", "usp_silencer/weapon_pist_usp_silencer", "pistol/pistol_hkp2000", "hkp", "glock", {
    silenced: true,
  }),
  gun("hkp2000", "pistol", "hkp2000/weapon_pist_hkp2000", "pistol/pistol_hkp2000", "hkp", "glock"),
  gun("p250", "pistol", "p250/weapon_pist_p250", "pistol/pistol_p250", "p250", "glock"),
  gun("fiveseven", "pistol", "fiveseven/weapon_pist_fiveseven", "pistol/pistol_fiveseven", "fiveseven", "glock"),
  gun("tec9", "pistol", "tec9/weapon_pist_tec9", "pistol/pistol_tec9", "tec9", "glock"),
  gun("cz75a", "pistol", "cz75a/weapon_pist_cz75a", "pistol/pistol_cz75a", "cz75a", "glock"),
  gun("deagle", "pistol", "deagle/weapon_pist_deagle", "pistol/pistol_deagle", "deagle", "deagle"),
  gun("revolver", "pistol", "revolver/weapon_pist_revolver", "pistol/pistol_revolver", "revolver", "deagle"),
  gun("elite", "pistol", "elite/weapon_pist_elite", "pistol/pistol_elite", "elite", "glock", {
    over: { shoot: null },
  }),
  gun("taser", "taser", "taser/weapon_pist_taser", "pistol/pistol_taser", "taser", null, {
    over: { reload: null },
  }),

  // Knives. Most use idle1_; the two defaults do not.
  knife("knife_bayonet", "knife_bayonet", "bayonet", "idle1_bayonet"),
  knife("knife_bowie", "knife_bowie", "bowie", "idle1_bowie"),
  knife("knife_butterfly", "knife_butterfly", "butterfly", "idle1_butterfly"),
  knife("knife_canis", "knife_canis", "canis", "idle1_canis"),
  knife("knife_cord", "knife_cord", "cord", "idle1_cord"),
  knife("knife_css", "knife_css", "css", "idle1_css"),
  knife("knife_falchion", "knife_falchion", "falchion", "idle1_falchion"),
  knife("knife_flip", "knife_flip", "flip", "idle1_flip"),
  knife("knife_gut", "knife_gut", "gut", "idle1_gut"),
  knife("knife_karambit", "knife_karambit", "karambit", "idle1_karambit"),
  knife("knife_kukri", "knife_kukri", "kukri", "idle1_kukri"),
  knife("knife_m9", "knife_m9", "m9", "idle1_m9"),
  knife("knife_navaja", "knife_navaja", "navaja", "idle1_navaja"),
  knife("knife_outdoor", "knife_outdoor", "outdoor", "idle1_outdoor"),
  knife("knife_push", "knife_push", "push", "idle1_push"),
  knife("knife_skeleton", "knife_skeleton", "skeleton", "idle1_skeleton"),
  knife("knife_stiletto", "knife_stiletto", "stiletto", "idle1_stiletto"),
  knife("knife_tactical", "knife_tactical", "tactical", "idle1_tactical"),
  knife("knife_talon", "knife_talon", "talon", "idle1_talon"),
  knife("knife_ursus", "knife_ursus", "ursus", "idle1_ursus"),
  knife("knife_default_t", "knife_default_t", "default_t", "idle_default_t"),
  // The CT default has a model but no pose set of its own.
  {
    id: "knife_default_ct",
    kind: "knife",
    model: "knife/knife_default_ct/weapon_knife_default_ct",
    poseSet: "knife/_default_knife",
    poses: poses("knife", { idle: "idle_knife", shoot: null, reload: null }),
    world: "knife",
    casing: null,
    silenced: false,
  },

  // Grenades.
  nade("hegrenade", "grenade/hegrenade/weapon_hegrenade", "grenade/grenade_hegrenade", "hegrenade"),
  nade("flashbang", "grenade/flashbang/weapon_flashbang", "grenade/grenade_flashbang", "flashbang"),
  nade("smokegrenade", "grenade/smokegrenade/weapon_smokegrenade", "grenade/grenade_smokegrenade", "smoke"),
  nade("molotov", "grenade/molotov/weapon_molotov", "grenade/grenade_molotov", "molotov"),
  nade("incgrenade", "grenade/incendiary/weapon_incendiarygrenade", "grenade/grenade_incendiary", "incendiary"),
  // No decoy pose set; falls back to the shared grenade set.
  nade("decoy", "grenade/decoy/weapon_decoy", "grenade/_default_grenade", "grenade"),

  // Equipment.
  {
    id: "c4",
    kind: "c4",
    model: "c4/weapon_c4",
    poseSet: "equipment/c4",
    poses: poses("c4", { shoot: null, reload: null }),
    world: "pistol",
    casing: null,
    silenced: false,
  },
  {
    id: "healthshot",
    kind: "equipment",
    model: "healthshot/weapon_healthshot",
    poseSet: "equipment/healthshot",
    poses: poses("healthshot", { shoot: null, reload: null }),
    world: "pistol",
    casing: null,
    silenced: false,
  },
];

export const WEAPONS: Record<string, WeaponInfo> = {};
for (const spec of SPECS) WEAPONS[spec.id] = spec;

/** Used when a weapon is unrecognised, so a new CS2 gun degrades instead of throwing. */
export const DEFAULT_WEAPON: WeaponInfo = {
  id: "unknown",
  kind: "rifle",
  model: null,
  poseSet: "rifle/_default_rifle",
  poses: poses("rifle"),
  world: "rifle",
  casing: "ak47",
  silenced: false,
};

/**
 * Strip to bare alphanumerics so display names and ids collapse together:
 * `AK-47`, `weapon_ak47` and `ak47` all become `ak47`.
 */
export function weaponKey(raw: string): string {
  const key = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return key.startsWith("weapon") ? key.slice(6) : key;
}

/** Display names and shorthands that do not collapse onto their canonical id. */
const ALIASES: Record<string, string> = {
  // Rifles and snipers.
  m4a1s: "m4a1_silencer",
  m4a1: "m4a1_silencer",
  sg553: "sg556",
  // SMGs.
  ppbizon: "bizon",
  // Pistols.
  glock: "glock18",
  usps: "usp_silencer",
  usp: "usp_silencer",
  p2000: "hkp2000",
  cz75auto: "cz75a",
  cz75: "cz75a",
  deserteagle: "deagle",
  r8revolver: "revolver",
  dualberettas: "elite",
  zeusx27: "taser",
  zeus: "taser",
  // Grenades.
  highexplosivegrenade: "hegrenade",
  he: "hegrenade",
  smoke: "smokegrenade",
  incendiarygrenade: "incgrenade",
  incendiary: "incgrenade",
  decoygrenade: "decoy",
  firebomb: "incgrenade",
  // Equipment.
  c4explosive: "c4",
  plantedc4: "c4",
  // Knives, by their in-game display names.
  bayonet: "knife_bayonet",
  bowieknife: "knife_bowie",
  butterflyknife: "knife_butterfly",
  survivalknife: "knife_canis",
  paracordknife: "knife_cord",
  classicknife: "knife_css",
  falchionknife: "knife_falchion",
  flipknife: "knife_flip",
  gutknife: "knife_gut",
  karambit: "knife_karambit",
  kukriknife: "knife_kukri",
  m9bayonet: "knife_m9",
  navajaknife: "knife_navaja",
  nomadknife: "knife_outdoor",
  shadowdaggers: "knife_push",
  skeletonknife: "knife_skeleton",
  stilettoknife: "knife_stiletto",
  huntsmanknife: "knife_tactical",
  talonknife: "knife_talon",
  ursusknife: "knife_ursus",
  knife: "knife_default_t",
  knifet: "knife_default_t",
  knifect: "knife_default_ct",
};

/** Canonical ids reached by their own normalised spelling, e.g. `usp_silencer`. */
const BY_KEY: Record<string, string> = {};
for (const id of Object.keys(WEAPONS)) BY_KEY[weaponKey(id)] = id;

export function resolveWeapon(raw: string): WeaponInfo {
  const key = weaponKey(raw);
  if (!key) return DEFAULT_WEAPON;
  const direct = BY_KEY[key] ?? ALIASES[key];
  if (direct) return WEAPONS[direct];
  // An unmapped knife skin is still a knife; anything else falls back to a rifle.
  if (key.includes("knife") || key.includes("bayonet") || key.includes("daggers")) {
    return WEAPONS.knife_default_t;
  }
  return DEFAULT_WEAPON;
}

const DISPLAY_NAME: Record<string, string> = {
  ak47: "AK-47",
  m4a4: "M4A4",
  m4a1_silencer: "M4A1-S",
  galilar: "Galil AR",
  famas: "FAMAS",
  aug: "AUG",
  sg556: "SG 553",
  awp: "AWP",
  ssg08: "SSG 08",
  scar20: "SCAR-20",
  g3sg1: "G3SG1",
  mac10: "MAC-10",
  mp9: "MP9",
  mp7: "MP7",
  mp5sd: "MP5-SD",
  ump45: "UMP-45",
  p90: "P90",
  bizon: "PP-Bizon",
  nova: "Nova",
  xm1014: "XM1014",
  mag7: "MAG-7",
  sawedoff: "Sawed-Off",
  m249: "M249",
  negev: "Negev",
  glock18: "Glock-18",
  usp_silencer: "USP-S",
  hkp2000: "P2000",
  p250: "P250",
  fiveseven: "Five-SeveN",
  tec9: "Tec-9",
  cz75a: "CZ75-Auto",
  deagle: "Desert Eagle",
  revolver: "R8 Revolver",
  elite: "Dual Berettas",
  taser: "Zeus x27",
  hegrenade: "HE Grenade",
  flashbang: "Flashbang",
  smokegrenade: "Smoke Grenade",
  molotov: "Molotov",
  incgrenade: "Incendiary",
  decoy: "Decoy",
  c4: "C4",
  healthshot: "Medi-Shot",
};

function titleCase(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** HUD / overlay name: `Desert Eagle`, not `desert eagle`. */
export function weaponDisplayName(raw: string): string {
  const info = resolveWeapon(raw);
  if (info.id !== "unknown" && DISPLAY_NAME[info.id]) return DISPLAY_NAME[info.id];
  if (info.id !== "unknown") return titleCase(info.id.replace(/_/g, " "));
  return titleCase(String(raw ?? "").replace(/^weapon_/, "").replace(/_/g, " "));
}

export function weaponKind(raw: string): WeaponKind {
  return resolveWeapon(raw).kind;
}

/** Only these weapons ever hide the viewmodel when `scoped` is set. */
export function weaponCanScope(raw: string): boolean {
  const info = resolveWeapon(raw);
  return info.kind === "sniper" || info.id === "aug" || info.id === "sg556";
}

/** Match `dump.grenades[].kind` for an equipped nade, or null. */
export function nadeFlightKind(raw: string): string | null {
  const info = resolveWeapon(raw);
  if (info.kind !== "nade") return null;
  if (info.id === "hegrenade") return "he";
  if (info.id === "flashbang") return "flash";
  if (info.id === "smokegrenade") return "smoke";
  if (info.id === "molotov" || info.id === "incgrenade") return "molotov";
  if (info.id === "decoy") return "decoy";
  return "other";
}

/** Casing model path under `weapons/models/`, or null for knives and grenades. */
export function casingModel(info: WeaponInfo): string | null {
  if (!info.casing) return null;
  const family = info.casing;
  const name = family.includes("/") ? family.split("/")[1] : family;
  const folder = family.includes("/") ? family.split("/")[0] : family;
  return `shared/shells/${folder}/${name}_casing`;
}
