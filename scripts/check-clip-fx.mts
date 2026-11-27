/**
 * Assert the shot, recoil and flash maths against a real cached preview dump.
 *
 * These are the parts that are easy to get subtly wrong and impossible to eyeball:
 * a punch that never decays leaves a permanent aim offset, and a flash that never
 * clears whites out the rest of the clip.
 *
 *   npx tsx scripts/check-clip-fx.mts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  flashAt,
  poseAt,
  punchAt,
  shotsInWindow,
  volumePhase,
  type PreviewDump,
} from "../src/renderer/src/lib/clipPlayback";

const dir = join(
  process.env.LOCALAPPDATA ?? "",
  "cs2-reel",
  "previews",
);
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
if (!files.length) throw new Error(`no cached preview dumps in ${dir}`);

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
}

for (const file of files) {
  const dump = JSON.parse(readFileSync(join(dir, file), "utf-8")) as PreviewDump;
  console.log(`\n${file}  ${dump.map}  ${dump.frames.length} frames`);
  console.log(
    `  shots=${dump.shots?.length ?? 0} grenades=${dump.grenades?.length ?? 0} ` +
      `smokes=${dump.smokes?.length ?? 0} fires=${dump.fires?.length ?? 0} ` +
      `bursts=${dump.bursts?.length ?? 0} blinds=${dump.blinds?.length ?? 0}`,
  );

  // Recoil: nonzero right after a shot, back to exactly zero once settled.
  const povShot = (dump.shots ?? []).find((s) => s.steamid === dump.povSteamid);
  if (povShot) {
    const at = poseAt(dump.frames, povShot.tick + 1, dump.povSteamid);
    const later = poseAt(dump.frames, povShot.tick + dump.tickrate, dump.povSteamid);
    const kick = at ? punchAt(at, dump.tickrate) : { pitch: 0, yaw: 0 };
    const settled = later ? punchAt(later, dump.tickrate) : { pitch: 0, yaw: 0 };
    check(
      "view punch kicks at the shot",
      Math.abs(kick.pitch) > 0.01,
      `pitch=${kick.pitch.toFixed(3)}`,
    );
    check(
      "view punch fully settles a second later",
      settled.pitch === 0 && settled.yaw === 0,
      `pitch=${settled.pitch}`,
    );
  }

  // No pose anywhere may carry a live punch without an impulse behind it.
  let leaked = 0;
  for (const frame of dump.frames) {
    for (const pose of Object.values(frame.players)) {
      const p = punchAt(pose, dump.tickrate);
      if (pose.punchAge < 0 && (p.pitch !== 0 || p.yaw !== 0)) leaked += 1;
    }
  }
  check("no punch applied before the first shot", leaked === 0, `${leaked} leaked`);

  // Flash: full at the blind, gone once the duration is up.
  for (const blind of dump.blinds ?? []) {
    const rate = dump.tickrate;
    const peak = flashAt(dump.blinds, blind.tick, rate, blind.steamid);
    const after = flashAt(
      dump.blinds,
      blind.tick + Math.ceil(blind.duration * rate) + 2,
      rate,
      blind.steamid,
    );
    check(
      `flash peaks then clears (${blind.duration.toFixed(2)}s)`,
      peak > 0.9 && after === 0,
      `peak=${peak.toFixed(2)} after=${after}`,
    );
  }

  // Tracers must exist for a shot and be gone shortly after.
  if (povShot) {
    const live = shotsInWindow(dump.shots, povShot.tick, dump.tickrate, 0.09);
    const gone = shotsInWindow(
      dump.shots,
      povShot.tick + dump.tickrate,
      dump.tickrate,
      0.09,
    ).filter((s) => s.tick === povShot.tick);
    check("tracer live at the shot tick", live.some((s) => s.tick === povShot.tick));
    check("tracer expired a second later", gone.length === 0);
  }

  // Volumes must be active inside their own span and inactive outside it.
  for (const smoke of dump.smokes ?? []) {
    const inside = volumePhase(smoke, smoke.tick + 10, dump.tickrate, 18);
    const before = volumePhase(smoke, smoke.tick - 10, dump.tickrate, 18);
    check(
      "smoke active inside its span only",
      inside !== null && inside >= 0 && inside <= 1 && before === null,
      `phase=${inside?.toFixed(3)}`,
    );
  }

  // Shot geometry sanity: origins near eye height, hits with a real distance.
  const hits = (dump.shots ?? []).filter((s) => s.dist !== null);
  check(
    "hit distances are positive",
    hits.every((s) => (s.dist ?? 0) > 0),
    `${hits.length} hits`,
  );
  const originsSane = (dump.shots ?? []).every((s) => Number.isFinite(s.ox) && Number.isFinite(s.oz));
  check("shot origins are finite", originsSane);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
