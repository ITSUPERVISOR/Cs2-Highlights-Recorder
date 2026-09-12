// Dev check: run the real loader + fit logic against the real exported GLB.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { containmentRatio, fitMapMesh, poseBoundsToThree } from "../src/renderer/src/lib/mapMesh";

const file = process.argv[2];
const buf = readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

// Pose bounds from the cached SLK clip dump.
const poses = poseBoundsToThree({
  minX: -165,
  maxX: 2526,
  minY: -364,
  maxY: 2328,
  minZ: 43,
  maxZ: 180,
});

const span = (b: THREE.Box3) => b.getSize(new THREE.Vector3()).toArray().map(Math.round).join(",");

new GLTFLoader().parse(ab, "", (gltf) => {
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);

  let meshes = 0;
  scene.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) meshes++;
  });
  const before = new THREE.Box3().setFromObject(scene);
  console.log(`meshes        ${meshes}`);
  console.log(`as loaded     span ${span(before)}  containment ${containmentRatio(before, poses).toFixed(3)}`);

  const fit = fitMapMesh(scene, poses);
  scene.updateMatrixWorld(true);
  const after = new THREE.Box3().setFromObject(scene);
  const ratio = containmentRatio(after, poses);
  console.log(`after fit     span ${span(after)}  containment ${ratio.toFixed(3)}`);
  console.log(`fit           ${fit}`);

  const ok = fit === "aligned" && ratio > 0.99;
  console.log(ok ? "PASS" : "FAIL");
  process.exit(ok ? 0 : 1);
});
