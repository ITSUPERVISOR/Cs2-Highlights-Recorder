// Dev check: the viewmodel must stay on screen and keep a sane size whether the
// Preview viewport is a thin letterbox or a full-window overlay.
import * as THREE from "three";
import { makeViewmodelRig, placeViewmodel } from "../src/renderer/src/lib/viewmodel";

const ASPECTS: [number, string][] = [
  [5.4, "inline letterbox (840x155)"],
  [2.6, "inline taller (840x320)"],
  [2.42, "expanded overlay (1500x620)"],
  [1.6, "narrow window"],
];

let ok = true;
for (const [aspect, label] of ASPECTS) {
  const camera = new THREE.PerspectiveCamera(54, aspect, 0.1, 200);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);

  const rig = makeViewmodelRig("ak47");
  placeViewmodel(rig, camera);
  rig.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(rig);
  const lo = new THREE.Vector2(Infinity, Infinity);
  const hi = new THREE.Vector2(-Infinity, -Infinity);
  let nearest = -Infinity;
  for (let i = 0; i < 8; i++) {
    const corner = new THREE.Vector3(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    );
    nearest = Math.max(nearest, corner.z); // less negative == closer to camera
    const ndc = corner.clone().project(camera);
    lo.min(new THREE.Vector2(ndc.x, ndc.y));
    hi.max(new THREE.Vector2(ndc.x, ndc.y));
  }

  const heightFrac = (hi.y - lo.y) / 2;
  const onScreen = hi.x > -1 && lo.x < 1 && hi.y > -1 && lo.y < 1;
  const inFront = nearest < -camera.near;
  const sane = heightFrac > 0.2 && heightFrac < 1.6;
  const pass = onScreen && inFront && sane;
  ok = ok && pass;

  const f = (n: number) => n.toFixed(2).padStart(6);
  console.log(
    `aspect ${aspect.toFixed(2)}  ndc x[${f(lo.x)},${f(hi.x)}] y[${f(lo.y)},${f(hi.y)}]  ` +
      `height ${(heightFrac * 100).toFixed(0)}% of half-screen  ${pass ? "ok " : "BAD"}  ${label}`,
  );
  if (!inFront) console.log(`   nearest corner z=${nearest.toFixed(2)} is not in front of near plane`);
}

console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
