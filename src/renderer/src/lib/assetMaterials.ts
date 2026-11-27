/**
 * Materials for the extracted CS2 models.
 *
 * The exports deliberately carry no 4K textures: CS2 ships those and the AK
 * alone came to 66.6 MB. Clip-scoped skins arrive as a 64px nearest albedo
 * when the demo names a paint kit; otherwise these Lambert fills posterize
 * like a PS1 vertex light.
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

/** Quantize an sRGB hex to `bits` per channel so solids band like PS1 lighting. */
export function posterizeColor(hex: number, bits = 5): number {
  const levels = (1 << bits) - 1;
  const quant = (channel: number) => Math.round((Math.round((channel / 255) * levels) / levels) * 255);
  return (quant((hex >> 16) & 255) << 16) | (quant((hex >> 8) & 255) << 8) | quant(hex & 255);
}

/** Crunchy, unlit-adjacent fill: Lambert, flat, no PBR gloss. */
export function previewLambert(hex: number): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({
    color: posterizeColor(hex),
    flatShading: true,
  });
}

/** Nearest, no mips — the 64px albedo should stay blocky on screen. */
export function crunchTexture(texture: THREE.Texture) {
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

let gunmetal: THREE.MeshLambertMaterial | null = null;
let furniture: THREE.MeshLambertMaterial | null = null;
let blade: THREE.MeshLambertMaterial | null = null;
let skin: THREE.MeshLambertMaterial | null = null;
let glove: THREE.MeshLambertMaterial | null = null;
let sleeve: THREE.MeshLambertMaterial | null = null;
const cloth = new Map<string, THREE.MeshLambertMaterial>();

export function gunmetalMaterial() {
  gunmetal ??= previewLambert(GUNMETAL);
  return gunmetal;
}

/** Polymer and wood: the parts of a gun that are not steel. */
export function furnitureMaterial() {
  furniture ??= previewLambert(GUN_FURNITURE);
  return furniture;
}

export function bladeMaterial() {
  blade ??= previewLambert(BLADE);
  return blade;
}

export function skinMaterial() {
  skin ??= previewLambert(SKIN);
  return skin;
}

export function gloveMaterial() {
  glove ??= previewLambert(GLOVE);
  return glove;
}

export function sleeveMaterial() {
  sleeve ??= previewLambert(SLEEVE);
  return sleeve;
}

/** Team-tinted fatigues, so sides stay readable at a glance. */
export function clothMaterial(team: string) {
  const key = team || "none";
  let mat = cloth.get(key);
  if (!mat) {
    mat = previewLambert(teamColor(team));
    cloth.set(key, mat);
  }
  return mat;
}

export function vestMaterial() {
  return previewLambert(VEST);
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
export function applyWeaponMaterials(root: THREE.Object3D, kind: string, map?: THREE.Texture | null) {
  const metal = kind === "knife" ? bladeMaterial() : gunmetalMaterial();
  const painted =
    map != null
      ? new THREE.MeshLambertMaterial({
          map: crunchTexture(map),
          color: 0xffffff,
          flatShading: true,
        })
      : metal;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    assign(mesh, painted);
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
