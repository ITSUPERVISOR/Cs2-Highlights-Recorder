import type { Group } from "three";
import { isCachedAsset, loadGltfCached } from "./loadGltf";

/**
 * The map's collision hull.
 *
 * A thin wrapper over the shared loader: maps have no skeleton and no clips, so
 * only the scene is of interest here.
 */
export function loadMapGltf(filePath: string | null | undefined): Promise<Group | null> {
  return loadGltfCached(filePath).then((loaded) => loaded?.scene ?? null);
}

export function isCachedMapMesh(obj: { userData?: Record<string, unknown> } | null | undefined) {
  return isCachedAsset(obj);
}
