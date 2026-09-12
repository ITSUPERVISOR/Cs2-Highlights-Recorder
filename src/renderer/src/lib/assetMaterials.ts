/**
 * Materials for the extracted CS2 models.
 *
 * The exports deliberately carry no textures: CS2 ships 4K PNGs and the AK alone
 * came to 66.6 MB of them, which is out of proportion to a pose replay. What the
 * exports *do* carry is `NORMAL` and `TANGENT`, so these plain materials still
 * shade properly and read as metal, fabric and skin rather than flat colour.
 *
 * Every material is a module-level singleton. Ten players holding an AK share
 * one gunmetal instance, which keeps the draw call count and the GPU program
 * count down.
 */

import * as THREE from "three";
import { teamColor } from "./playerRig";

const GUNMETAL = 0x5c6168;
const GUN_FURNITURE = 0x1e2126;
const BLADE = 0xb9bec6;
const SKIN = 0xba8f68;
const GLOVE = 0x6a5848;
const SLEEVE = 0x3d4450;
const VEST = 0x24272d;

let gunmetal: THREE.MeshStandardMaterial | null = null;
let furniture: THREE.MeshStandardMaterial | null = null;
let blade: THREE.MeshStandardMaterial | null = null;
let skin: THREE.MeshStandardMaterial | null = null;
let glove: THREE.MeshStandardMaterial | null = null;
let sleeve: THREE.MeshStandardMaterial | null = null;
const cloth = new Map<string, THREE.MeshStandardMaterial>();

export function gunmetalMaterial() {
  gunmetal ??= new THREE.MeshStandardMaterial({ color: GUNMETAL, roughness: 0.32, metalness: 0.82 });
  return gunmetal;
}

/** Polymer and wood: the parts of a gun that are not steel. */
export function furnitureMaterial() {
  furniture ??= new THREE.MeshStandardMaterial({ color: GUN_FURNITURE, roughness: 0.72, metalness: 0.08 });
  return furniture;
}

export function bladeMaterial() {
  blade ??= new THREE.MeshStandardMaterial({ color: BLADE, roughness: 0.18, metalness: 0.92 });
  return blade;
}

export function skinMaterial() {
  skin ??= new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.78, metalness: 0.02 });
  return skin;
}

export function gloveMaterial() {
  glove ??= new THREE.MeshStandardMaterial({ color: GLOVE, roughness: 0.66, metalness: 0.06 });
  return glove;
}

export function sleeveMaterial() {
  sleeve ??= new THREE.MeshStandardMaterial({ color: SLEEVE, roughness: 0.7, metalness: 0.05 });
  return sleeve;
}

/** Team-tinted fatigues, so sides stay readable at a glance. */
export function clothMaterial(team: string) {
  const key = team || "none";
  let mat = cloth.get(key);
  if (!mat) {
    mat = new THREE.MeshStandardMaterial({
      color: teamColor(team),
      roughness: 0.66,
      metalness: 0.06,
    });
    cloth.set(key, mat);
  }
  return mat;
}

export function vestMaterial() {
  return new THREE.MeshStandardMaterial({ color: VEST, roughness: 0.55, metalness: 0.12 });
}

function assign(mesh: THREE.Mesh, material: THREE.Material) {
  // The loader hands back one default material per primitive; replacing the
  // array element-wise keeps multi-primitive meshes intact.
  if (Array.isArray(mesh.material)) mesh.material = mesh.material.map(() => material);
  else mesh.material = material;
}

/**
 * Shade a weapon. Knives read as a blade, everything else as steel.
 *
 * Without per-material data from the export there is no way to tell a stock from
 * a barrel, so one convincing metal beats a wrong guess at two.
 */
export function applyWeaponMaterials(root: THREE.Object3D, kind: string) {
  const metal = kind === "knife" ? bladeMaterial() : gunmetalMaterial();
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    assign(mesh, metal);
  });
}

/** Shade an agent by mesh name: hands as skin, sleeves and body as team cloth. */
export function applyAgentMaterials(root: THREE.Object3D, team: string) {
  const body = clothMaterial(team);
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const name = mesh.name.toLowerCase();
    // `firstperson_default_gloves_arms` contains "arms", so glove has to win
    // or the viewmodel paints as bare skin.
    if (name.includes("glove")) assign(mesh, gloveMaterial());
    else if (name.includes("sleeve")) assign(mesh, sleeveMaterial());
    else if (name.includes("arms")) assign(mesh, skinMaterial());
    else assign(mesh, body);
  });
}
