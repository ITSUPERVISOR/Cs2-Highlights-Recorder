// Dev check: run the real fit logic against the de_inferno data observed on disk.
import * as THREE from "three";
import { containmentRatio, fitMapMesh, poseBoundsToThree } from "../src/renderer/src/lib/mapMesh";

// Raw vertex bounds from scripts/inspect-glb.mjs (CS2 inches, Z-up).
const RAW_MIN = [-3552, -2872, -280];
const RAW_MAX = [3968, 4264, 1624];
// The single node matrix every mesh in de_inferno_physics.glb carries.
const NODE_MATRIX = [
  3.02792e-9, 0, 0.0254, 0, 0.0254, 3.02792e-9, 0, 0, 0, 0.0254, 3.02792e-9, 0, 0, 0, 0, 1,
];
// Pose bounds from the cached SLK clip dump.
const poses = poseBoundsToThree({
  minX: -165,
  maxX: 2526,
  minY: -364,
  maxY: 2328,
  minZ: 43,
  maxZ: 180,
});

function buildScene() {
  const size = RAW_MAX.map((v, i) => v - RAW_MIN[i]);
  const geo = new THREE.BoxGeometry(size[0], size[1], size[2]);
  geo.translate(...(RAW_MIN.map((v, i) => (v + RAW_MAX[i]) / 2) as [number, number, number]));
  const child = new THREE.Mesh(geo);
  // glTF matrices are column-major, which is three.js's fromArray order.
  child.applyMatrix4(new THREE.Matrix4().fromArray(NODE_MATRIX));
  const root = new THREE.Group();
  root.add(child);
  return root;
}

const before = buildScene();
before.updateMatrixWorld(true);
const beforeBox = new THREE.Box3().setFromObject(before);
console.log(`as loaded    span ${beforeBox.getSize(new THREE.Vector3()).toArray().map(Math.round)}`);
console.log(`             containment ${containmentRatio(beforeBox, poses).toFixed(3)}`);

const root = buildScene();
const fit = fitMapMesh(root, poses);
root.updateMatrixWorld(true);
const box = new THREE.Box3().setFromObject(root);
console.log(`after fit    span ${box.getSize(new THREE.Vector3()).toArray().map(Math.round)}`);
console.log(`             containment ${containmentRatio(box, poses).toFixed(3)}`);
console.log(`fit          ${fit}`);

const ok = fit === "aligned" && containmentRatio(box, poses) > 0.99;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
