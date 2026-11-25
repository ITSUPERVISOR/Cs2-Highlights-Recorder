import type { PreviewDump } from "./clipPlayback";
import { mergeAssetBundles, type AssetBundle } from "./gameAssets";
import type { MatchRow } from "./types";

const CLIP_LIMIT = 6;

export type WarmClip = {
  dump: PreviewDump;
  match: MatchRow | null;
  mapStatus: "loading" | "ready" | "failed" | "mismatch";
  armsStatus: "real" | "procedural" | "failed";
  ready: boolean;
};

type ClipEntry = {
  dump: PreviewDump;
  warm: WarmClip | null;
};

const clips = new Map<string, ClipEntry>();
let assets: AssetBundle | null = null;

function touch(id: string) {
  const entry = clips.get(id);
  if (!entry) return null;
  clips.delete(id);
  clips.set(id, entry);
  return entry;
}

function evict() {
  while (clips.size > CLIP_LIMIT) {
    const oldest = clips.keys().next().value;
    if (oldest === undefined) break;
    clips.delete(oldest);
  }
}

export function getCachedDump(id: string) {
  return touch(id)?.dump ?? null;
}

export function putCachedDump(id: string, dump: PreviewDump) {
  const existing = clips.get(id);
  const warm = existing?.warm ? { ...existing.warm, dump } : null;
  clips.delete(id);
  clips.set(id, { dump, warm });
  evict();
}

export function getWarmClip(id: string) {
  return touch(id)?.warm ?? null;
}

export function putWarmClip(id: string, clip: WarmClip) {
  clips.delete(id);
  clips.set(id, { dump: clip.dump, warm: clip });
  evict();
}

export function getSharedAssets() {
  return assets;
}

export function putSharedAssets(bundle: AssetBundle | null) {
  if (!bundle) return assets;
  assets = assets ? mergeAssetBundles(assets, bundle) : bundle;
  return assets;
}
