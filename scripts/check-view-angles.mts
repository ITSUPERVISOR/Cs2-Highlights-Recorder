// Dev check: the euler we apply must actually aim along the player's view vector,
// and the old formula must be shown to disagree.
import * as THREE from "three";
import { cs2Forward, cs2ViewEuler } from "../src/renderer/src/lib/viewAngles";

const CASES: [number, number, string][] = [
  [0, 0, "level, facing +X"],
  [0, 90, "level, facing +Y"],
  [0, 180, "level, facing -X"],
  [0, -90, "level, facing -Y"],
  [0, 45, "level, diagonal"],
  [30, 137, "looking down, odd yaw"],
  [-25, -63, "looking up, odd yaw"],
];

const forwardFrom = (euler: THREE.Euler) =>
  new THREE.Vector3(0, 0, -1).applyEuler(euler).normalize();

let worst = 0;
let worstOld = 0;
for (const [pitch, yaw, label] of CASES) {
  const want = cs2Forward(pitch, yaw);
  const got = forwardFrom(cs2ViewEuler(pitch, yaw));
  // What the code did before: pitch un-negated, yaw negated.
  const old = forwardFrom(
    new THREE.Euler(
      THREE.MathUtils.degToRad(pitch),
      -THREE.MathUtils.degToRad(yaw) - Math.PI / 2,
      0,
      "YXZ",
    ),
  );
  const err = want.distanceTo(got);
  const errOld = want.distanceTo(old);
  worst = Math.max(worst, err);
  worstOld = Math.max(worstOld, errOld);
  const f = (v: THREE.Vector3) => v.toArray().map((n) => n.toFixed(2)).join(",");
  console.log(
    `pitch ${String(pitch).padStart(4)} yaw ${String(yaw).padStart(4)}  want ${f(want)}  fixed ${f(got)} (err ${err.toFixed(4)})  old ${f(old)} (err ${errOld.toFixed(3)})  ${label}`,
  );
}

console.log(`\nworst error  fixed ${worst.toFixed(6)}   old ${worstOld.toFixed(3)}`);
const ok = worst < 1e-9 && worstOld > 0.1;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
