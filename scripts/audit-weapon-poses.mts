/**
 * Audit weaponTable viewmodel pose names against the live CS2 pak01.
 *
 *   npx tsx scripts/audit-weapon-poses.mts
 */
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WEAPONS } from "../src/renderer/src/lib/weaponTable";
import { AGENT_BY_TEAM, FALLBACK_AGENT, buildPriorityAssetSpec, viewmodelAnims } from "../src/renderer/src/lib/assetSpec";
import type { PreviewDump } from "../src/renderer/src/lib/clipPlayback";

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const poses = [...new Set(Object.values(WEAPONS).flatMap((info) => viewmodelAnims(info)))].sort();
const specPath = join(tmpdir(), "reel-pose-audit.json");
writeFileSync(specPath, JSON.stringify({ poses }));

const pythonCandidates = [
  join(root, "core", ".venv", "Scripts", "python.exe"),
  join(root, "core", ".venv", "bin", "python"),
  "python",
];
const python = pythonCandidates.find((bin) => bin === "python" || existsSync(bin)) ?? "python";

const result = spawnSync(
  python,
  ["-m", "reel_core", "preview-audit-poses", "--spec", specPath, "--json"],
  { cwd: join(root, "core"), encoding: "utf8" },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

const stdout = result.stdout || "";
const start = stdout.indexOf("{");
const end = stdout.lastIndexOf("}");
if (start < 0 || end < start) {
  console.error(stdout || result.stderr || "pose audit produced no JSON");
  process.exit(1);
}

const payload = JSON.parse(stdout.slice(start, end + 1)) as {
  ok?: boolean;
  error?: string;
  missing?: string[];
  found?: string[];
  listed?: number;
};

console.log(`listed ${payload.listed ?? 0} viewmodel clips in pak01`);
console.log(`checked ${poses.length} table poses`);
const missing = payload.missing ?? [];
if (payload.error && !payload.listed) {
  console.log(`skip: ${payload.error}`);
} else if (missing.length) {
  console.log(`${missing.length} missing:`);
  for (const name of missing) console.log(`  ${name}`);
} else {
  console.log("all table poses present");
}

const tDump = {
  povSteamid: "1",
  frames: [{ tick: 1, players: { "1": { weapon: "ak47", team: "T" } } }],
} as unknown as PreviewDump;
const spec = buildPriorityAssetSpec(tDump);
const tAgent = AGENT_BY_TEAM.T;
if (!spec.agents[tAgent] || !spec.agents[FALLBACK_AGENT]) {
  console.log("FAIL T POV does not export SAS fallback");
  process.exit(1);
}
console.log(`T POV exports ${tAgent} plus ${FALLBACK_AGENT} fallback`);

process.exit(missing.length && payload.listed ? 1 : result.status && result.status !== 0 ? 1 : 0);
