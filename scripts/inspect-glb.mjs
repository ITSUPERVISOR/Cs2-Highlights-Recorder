// Dev helper: report glTF binary bounds without loading the whole mesh.
import { openSync, readSync, closeSync, statSync } from "node:fs";

const file = process.argv[2];
const fd = openSync(file, "r");
const header = Buffer.alloc(20);
readSync(fd, header, 0, 20, 0);
if (header.readUInt32LE(0) !== 0x46546c67) throw new Error("not a glb");
const jsonLen = header.readUInt32LE(12);
const json = Buffer.alloc(jsonLen);
readSync(fd, json, 0, jsonLen, 20);
closeSync(fd);

const gltf = JSON.parse(json.toString("utf8"));
const lo = [Infinity, Infinity, Infinity];
const hi = [-Infinity, -Infinity, -Infinity];
let verts = 0;
let tris = 0;
for (const mesh of gltf.meshes ?? []) {
  for (const prim of mesh.primitives ?? []) {
    const pos = gltf.accessors?.[prim.attributes?.POSITION];
    if (!pos?.min) continue;
    verts += pos.count;
    if (prim.indices != null) tris += (gltf.accessors[prim.indices].count / 3) | 0;
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], pos.min[i]);
      hi[i] = Math.max(hi[i], pos.max[i]);
    }
  }
}
const xforms = new Set();
for (const node of gltf.nodes ?? []) {
  if (node.matrix) xforms.add(node.matrix.map((n) => +n.toPrecision(6)).join(","));
  else xforms.add(`trs:${node.translation ?? "-"}|${node.rotation ?? "-"}|${node.scale ?? "-"}`);
}
console.log(`unique node transforms: ${xforms.size}`);
for (const x of [...xforms].slice(0, 3)) console.log(`  ${x}`);

const r = (n) => Math.round(n);
console.log(`file       ${(statSync(file).size / 1048576).toFixed(1)} MB`);
console.log(`meshes     ${gltf.meshes?.length ?? 0}  nodes ${gltf.nodes?.length ?? 0}`);
console.log(`vertices   ${verts.toLocaleString()}   triangles ${tris.toLocaleString()}`);
console.log(`bounds min [${lo.map(r)}]`);
console.log(`bounds max [${hi.map(r)}]`);
