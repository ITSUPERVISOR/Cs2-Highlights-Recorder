import type { PreviewDump } from "./clipPlayback";
import { mergeAssetBundles, type AssetBundle } from "./gameAssets";
import type { MatchRow } from "./types";

const dumps = new Map<string, PreviewDump>();
const warm = new Map<string, WarmClip>();
let assets: AssetBundle | null = null;

export type WarmClip = {
  dump: PreviewDump;
  match: MatchRow | null;
  mapStatus: "loading" | "ready" | "failed" | "mismatch";
  armsStatus: "real" | "procedural" | "failed";
  ready: boolean;
};

export function getCachedDump(id: string) {
  return dumps.get(id) ?? null;
}

export function putCachedDump(id: string, dump: PreviewDump) {
  dumps.set(id, dump);
}

export function getWarmClip(id: string) {
  return warm.get(id) ?? null;
}

export function putWarmClip(id: string, clip: WarmClip) {
  warm.delete(id);
  warm.set(id, clip);
  dumps.set(id, clip.dump);
}

export function getSharedAssets() {
  return assets;
}

export function putSharedAssets(bundle: AssetBundle | null) {
  if (!bundle) return assets;
  assets = assets ? mergeAssetBundles(assets, bundle) : bundle;
  return assets;
}
