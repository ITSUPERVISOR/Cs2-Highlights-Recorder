/**
 * Bringing exported CS2 models into Preview's coordinate system.
 *
 * Three conversions matter, and getting any of them wrong is the difference
 * between a gun and a speck or a gun pointing backwards:
 *
 * - **Units.** Source exports in metres; everything in Preview is CS2 inches.
 * - **Facing.** Weapon barrels run along **+Z**, while every rig here assumes
 *   **-Z** forward, so models are turned 180 degrees about Y.
 * - **Node transforms are near identity**, unlike the map export's 0.0254 scale
 *   and cyclic axis permutation, so `normalizeSourceMesh` from `mapMesh.ts` must
 *   *not* be reused. It would apply the map's correction a second time.
 *
 * Skinned models are transformed by a wrapper parent rather than by editing the
 * mesh, because baking a scale into a `SkinnedMesh` fights the skeleton.
 */

import * as THREE from "three";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import { loadGltfCached, type LoadedGltf } from "./loadGltf";

export const METRES_TO_INCHES = 39.3701;

/** What `core:previewAssets` hands back. */
export type AssetBundle = {
  ok: boolean;
  /** Model path under `weapons/models` to the cached .glb on disk. */
  weapons: Record<string, string>;
  /** Agent name to the cached .glb on disk. */
  agents: Record<string, string>;
  /** Paint-kit key to a 64px albedo PNG. */
  skins: Record<string, string>;
  weaponsMissing: string[];
  /** Animation names the exporter did not recognise, per agent. */
  unmatchedAnims: Record<string, string[]>;
  cacheDir: string;
};

/**
 * Drop the low LOD when the high one is present.
 *
 * Guns ship `body_hd` (21,450 verts) and `body_legacy` (12,935). Both are in the
 * export on purpose: filtering meshes at export time silently produced an empty
 * file for knives, which only ever carry `body_legacy`. So the choice is made
 * here, where both are visible.
 */
export function pruneLods(root: THREE.Object3D) {
  const meshes: THREE.Mesh[] = [];
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) meshes.push(mesh);
  });
  // Names arrive as `weapons\models\ak47\weapon_rif_ak47.vmdl_c.body_hd`, and a
  // multi-primitive mesh gains a `_1`/`_2` suffix on top, so this matches on a
  // substring. `endsWith` looks right and quietly never fires.
  const hasHd = meshes.some((mesh) => mesh.name.includes("body_hd"));
  if (!hasHd) return;
  for (const mesh of meshes) {
    if (mesh.name.includes("body_legacy")) mesh.visible = false;
  }
}

/** World-space bounds of the geometry only, ignoring bones and empties. */
export function meshBounds(root: THREE.Object3D): THREE.Box3 {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const scratch = new THREE.Box3();
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible || !mesh.geometry) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const local = mesh.geometry.boundingBox;
    if (!local) return;
    scratch.copy(local).applyMatrix4(mesh.matrixWorld);
    box.union(scratch);
  });
  return box;
}

export type AssetInstance = {
  /** Wrapper carrying the unit and facing correction. Add this to a scene. */
  root: THREE.Group;
  /** The converted model itself, a child of `root`. */
  model: THREE.Group;
  animations: THREE.AnimationClip[];
};

/**
 * A fresh, independently posable copy.
 *
 * `SkeletonUtils.clone` rather than `Object3D.clone`: the latter leaves every
 * copy sharing one skeleton, so ten players holding an AK would all snap to
 * whichever pose was written last. Geometry and materials are still shared, so
 * the copy is cheap.
 */
export function instantiate(
  loaded: LoadedGltf,
  opts: { flipForward?: boolean; scale?: number } = {},
): AssetInstance {
  const model = cloneSkeleton(loaded.scene) as THREE.Group;
  model.userData.cached = false;
  pruneLods(model);

  const root = new THREE.Group();
  root.name = "assetRoot";
  // scale 1 keeps the model in its native metres, which is what an attachment
  // bone on an already-scaled skeleton expects.
  root.scale.setScalar(opts.scale ?? METRES_TO_INCHES);
  if (opts.flipForward !== false) root.rotation.y = Math.PI;
  root.add(model);
  root.updateMatrixWorld(true);

  return { root, model, animations: loaded.animations };
}

export async function loadAsset(filePath: string | null | undefined): Promise<LoadedGltf | null> {
  return loadGltfCached(filePath);
}

const textureCache = new Map<string, THREE.Texture>();
const textureInflight = new Map<string, Promise<THREE.Texture | null>>();

/** A PNG/JPEG under the AppData cache, loaded through the reelmap protocol. */
export function loadPreviewTexture(filePath: string | null | undefined): Promise<THREE.Texture | null> {
  if (!filePath) return Promise.resolve(null);
  const hit = textureCache.get(filePath);
  if (hit) return Promise.resolve(hit);
  const pending = textureInflight.get(filePath);
  if (pending) return pending;
  const job = new Promise<THREE.Texture | null>((resolve) => {
    const url = `reelmap://asset/?path=${encodeURIComponent(filePath.replace(/\\/g, "/"))}`;
    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
        texture.generateMipmaps = false;
        textureCache.set(filePath, texture);
        resolve(texture);
      },
      undefined,
      () => resolve(null),
    );
  }).finally(() => textureInflight.delete(filePath));
  textureInflight.set(filePath, job);
  return job;
}

/** Nodes by name, for looking up bones without walking the tree each frame. */
export function collectBones(root: THREE.Object3D): Map<string, THREE.Object3D> {
  const bones = new Map<string, THREE.Object3D>();
  root.traverse((child) => {
    if (child.name && !bones.has(child.name)) bones.set(child.name, child);
  });
  return bones;
}

/** Find a clip by exact name, then by trailing path segment. */
export function findClip(
  animations: THREE.AnimationClip[],
  name: string | null | undefined,
): THREE.AnimationClip | null {
  if (!name) return null;
  const exact = animations.find((clip) => clip.name === name);
  if (exact) return exact;
  // Agent clips keep their full `animation/anims/...` path as the name.
  const suffix = animations.find((clip) => clip.name.split("/").pop() === name);
  return suffix ?? null;
}

export function bundleWeaponPath(bundle: AssetBundle | null, model: string | null): string | null {
  if (!bundle || !model) return null;
  return bundle.weapons?.[model] ?? null;
}

export function bundleAgentPath(bundle: AssetBundle | null, agent: string): string | null {
  if (!bundle) return null;
  return bundle.agents?.[agent] ?? null;
}

export function bundleSkinPath(bundle: AssetBundle | null, key: string | null | undefined): string | null {
  if (!bundle || !key) return null;
  return bundle.skins?.[key] ?? null;
}

/** Wave-2 paths win; missing-anim lists are unioned so the footer can report them. */
export function mergeAssetBundles(base: AssetBundle | null, extra: AssetBundle): AssetBundle {
  const unmatched: Record<string, string[]> = { ...(base?.unmatchedAnims ?? {}) };
  for (const [agent, names] of Object.entries(extra.unmatchedAnims ?? {})) {
    unmatched[agent] = [...new Set([...(unmatched[agent] ?? []), ...names])].sort();
  }
  return {
    ok: Boolean(base?.ok || extra.ok),
    weapons: { ...base?.weapons, ...extra.weapons },
    agents: { ...base?.agents, ...extra.agents },
    skins: { ...base?.skins, ...(extra.skins ?? {}) },
    weaponsMissing: [...new Set([...(base?.weaponsMissing ?? []), ...(extra.weaponsMissing ?? [])])].sort(),
    unmatchedAnims: unmatched,
    cacheDir: extra.cacheDir || base?.cacheDir || "",
  };
}
