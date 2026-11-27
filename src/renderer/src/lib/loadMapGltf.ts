import type { Group } from "three";
import { isCachedAsset, loadGltfCached } from "./loadGltf";

export function isUnsafeMapMesh(filePath: string | null | undefined) {
  if (!filePath) return false;
  const norm = filePath.replace(/\\/g, "/").toLowerCase();
  return /\/maps\/[^/]+\/high\//.test(norm);
}

/** Drop world64 paths so Preview never uploads the CS2 world mesh. */
export function stripUnsafeMap<T extends { mapGltf?: string | null; mapSource?: string }>(dump: T): T {
  if (dump.mapSource !== "world64" && !isUnsafeMapMesh(dump.mapGltf)) return dump;
  return {
    ...dump,
    mapGltf: isUnsafeMapMesh(dump.mapGltf) ? null : dump.mapGltf,
    mapSource: dump.mapSource === "world64" ? "fallback" : dump.mapSource,
  };
}

/**
 * The map's collision hull.
 *
 * A thin wrapper over the shared loader: maps have no skeleton and no clips, so
 * only the scene is of interest here.
 *
 * Paths under `maps/<map>/high/` are the old world64 export. Loading them
 * exhausts GPU memory and can freeze the whole machine, so they are refused.
 */
export function loadMapGltf(filePath: string | null | undefined): Promise<Group | null> {
  if (isUnsafeMapMesh(filePath)) return Promise.resolve(null);
  return loadGltfCached(filePath).then((loaded) => loaded?.scene ?? null);
}

export function isCachedMapMesh(obj: { userData?: Record<string, unknown> } | null | undefined) {
  return isCachedAsset(obj);
}
