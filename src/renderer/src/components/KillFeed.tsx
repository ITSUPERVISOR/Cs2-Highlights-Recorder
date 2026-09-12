import { useState } from "react";
import type { Kill } from "../lib/types";

function normalizeWeapon(weapon: string) {
  return weapon
    .toLowerCase()
    .replace(/^weapon_/, "")
    .replace(/[- ]/g, "_")
    .replace(/_+$/, "");
}

/** Map parser weapon ids → CS2 panorama equipment SVG filenames (no .svg). */
const WEAPON_ICON: Record<string, string> = {
  ak47: "ak47",
  m4a1: "m4a1",
  m4a4: "m4a1",
  m4a1_silencer: "m4a1_silencer",
  m4a1_silencer_off: "m4a1_silencer_off",
  famas: "famas",
  galilar: "galilar",
  galil: "galilar",
  aug: "aug",
  sg556: "sg556",
  awp: "awp",
  ssg08: "ssg08",
  scar20: "scar20",
  g3sg1: "g3sg1",
  mac10: "mac10",
  mp9: "mp9",
  mp7: "mp7",
  mp5sd: "mp5sd",
  ump45: "ump45",
  p90: "p90",
  bizon: "bizon",
  glock: "glock",
  usp_silencer: "usp_silencer",
  usp_silencer_off: "usp_silencer_off",
  hkp2000: "hkp2000",
  p2000: "hkp2000",
  p250: "p250",
  tec9: "tec9",
  fiveseven: "fiveseven",
  deagle: "deagle",
  revolver: "revolver",
  elite: "elite",
  cz75a: "cz75a",
  nova: "nova",
  xm1014: "xm1014",
  mag7: "mag7",
  sawedoff: "sawedoff",
  m249: "m249",
  negev: "negev",
  hegrenade: "hegrenade",
  flashbang: "flashbang",
  smokegrenade: "smokegrenade",
  molotov: "molotov",
  incgrenade: "incgrenade",
  inferno: "inferno",
  decoy: "decoy",
  taser: "taser",
  zeus: "taser",
  knife: "knife",
  knife_t: "knife_t",
  bayonet: "bayonet",
  knifegg: "knifegg",
  knife_css: "knife_css",
  knife_flip: "knife_flip",
  knife_gut: "knife_gut",
  knife_karambit: "knife_karambit",
  knife_m9_bayonet: "knife_m9_bayonet",
  knife_tactical: "knife_tactical",
  knife_falchion: "knife_falchion",
  knife_survival_bowie: "knife_survival_bowie",
  knife_bowie: "knife_bowie",
  knife_butterfly: "knife_butterfly",
  knife_push: "knife_push",
  knife_cord: "knife_cord",
  knife_canis: "knife_canis",
  knife_ursus: "knife_ursus",
  knife_gypsy_jackknife: "knife_gypsy_jackknife",
  knife_outdoor: "knife_outdoor",
  knife_stiletto: "knife_stiletto",
  knife_widowmaker: "knife_widowmaker",
  knife_skeleton: "knife_skeleton",
  knife_kukri: "knife_kukri",
  knife_twinblade: "knife_twinblade",
  c4: "c4",
  planted_c4: "planted_c4",
};

const WEAPON_LABEL: Record<string, string> = {
  ak47: "AK-47",
  m4a1: "M4A4",
  m4a4: "M4A4",
  m4a1_silencer: "M4A1-S",
  famas: "FAMAS",
  galilar: "Galil",
  awp: "AWP",
  ssg08: "SSG 08",
  deagle: "Desert Eagle",
  usp_silencer: "USP-S",
  hkp2000: "P2000",
  glock: "Glock",
  taser: "Zeus",
};

function weaponIconId(weapon: string): string | null {
  const key = normalizeWeapon(weapon);
  if (WEAPON_ICON[key]) return WEAPON_ICON[key];
  if (key.startsWith("knife")) return WEAPON_ICON[key] ?? "knife";
  // Try raw key if SVG exists under that name
  if (/^[a-z0-9_]+$/.test(key)) return key;
  return null;
}

function weaponLabel(weapon: string) {
  const key = normalizeWeapon(weapon);
  return WEAPON_LABEL[key] ?? key.replace(/_/g, " ");
}

function weaponSrc(iconId: string) {
  const base = import.meta.env.BASE_URL || "./";
  const root = base.endsWith("/") ? base : `${base}/`;
  return `${root}weapons/${iconId}.svg`;
}

function WeaponIcon({ weapon }: { weapon: string }) {
  const iconId = weaponIconId(weapon);
  const label = weaponLabel(weapon);
  const [failed, setFailed] = useState(false);

  if (!iconId || failed) {
    return <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-300">{label}</span>;
  }

  return (
    <img
      src={weaponSrc(iconId)}
      alt={label}
      title={label}
      width={72}
      height={26}
      draggable={false}
      onError={() => setFailed(true)}
      className="h-[18px] w-auto max-w-[4.75rem] shrink-0 object-contain object-left"
    />
  );
}

function HsMark() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 text-amber" aria-label="headshot">
      <circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6" cy="6" r="1.4" fill="currentColor" />
    </svg>
  );
}

function modifiers(kill: Kill): string[] {
  const tags: string[] = [];
  if (kill.noscope) tags.push("NS");
  if (kill.thrusmoke) tags.push("smoke");
  if (kill.flashed) tags.push("flash");
  if (kill.wallbang) tags.push("WB");
  return tags;
}

export function KillNotice({ kill }: { kill: Kill }) {
  const mods = modifiers(kill);
  return (
    <span
      title={`${weaponLabel(kill.weapon)}${kill.headshot ? " HS" : ""} ${mods.join(" ")} → ${kill.victimName}`}
      className="inline-flex items-center gap-1.5 rounded-md border border-white/5 bg-black/50 px-2 py-1 text-xs text-white"
    >
      <WeaponIcon weapon={kill.weapon} />
      {kill.headshot && <HsMark />}
      {mods.map((mod) => (
        <span key={mod} className="rounded bg-amber/15 px-1 text-[9px] font-semibold uppercase tracking-wide text-amber">
          {mod}
        </span>
      ))}
      <span className="max-w-[9rem] truncate font-medium">{kill.victimName || "unknown"}</span>
    </span>
  );
}

export function KillFeed({ kills }: { kills: Kill[] }) {
  if (!kills.length) {
    return <p className="text-sm text-muted">Clutch / utility</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {kills.map((kill, index) => (
        <KillNotice key={`${kill.tick}-${kill.victimSteamid}-${index}`} kill={kill} />
      ))}
    </div>
  );
}
