/**
 * Shared glTF loading for everything Preview pulls out of the CS2 install.
 *
 * Split out of `loadMapGltf` once weapons and player models arrived, because
 * those are *skinned* and carry animation clips. The map loader threw
 * `gltf.animations` away, which is exactly the data the arms and the bolt need.
 */

import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";

export type LoadedGltf = {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
};

function asArrayBuffer(raw: unknown): ArrayBuffer | null {
  if (!raw) return null;
  if (raw instanceof ArrayBuffer) return raw;
  if (ArrayBuffer.isView(raw)) {
    const view = raw;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  const rec = raw as { type?: string; data?: number[] };
  if (rec.type === "Buffer" && Array.isArray(rec.data)) {
    return Uint8Array.from(rec.data).buffer;
  }
  return null;
}

function sibling(filePath: string, name: string) {
  const cut = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  const dir = cut >= 0 ? filePath.slice(0, cut + 1) : "";
  return `${dir}${name}`;
}

function mimeFor(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

function toDataUri(bytes: ArrayBuffer, mime: string) {
  const arr = new Uint8Array(bytes);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < arr.length; i += chunk) {
    const slice = arr.subarray(i, i + chunk);
    for (let j = 0; j < slice.length; j++) binary += String.fromCharCode(slice[j]);
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function isGlb(buf: ArrayBuffer) {
  if (buf.byteLength < 4) return false;
  return new TextDecoder().decode(new Uint8Array(buf, 0, 4)) === "glTF";
}

async function embedExternalUris(
  json: { buffers?: { uri?: string }[]; images?: { uri?: string }[] },
  filePath: string,
) {
  const read = window.reel.readPreviewFile;
  for (const buf of json.buffers ?? []) {
    if (!buf.uri || buf.uri.startsWith("data:")) continue;
    const raw = await read(sibling(filePath, buf.uri));
    const bytes = asArrayBuffer(raw);
    if (bytes) buf.uri = toDataUri(bytes, mimeFor(buf.uri));
  }
  for (const img of json.images ?? []) {
    if (!img.uri || img.uri.startsWith("data:") || img.uri.startsWith("#")) continue;
    const raw = await read(sibling(filePath, img.uri));
    const bytes = asArrayBuffer(raw);
    if (bytes) img.uri = toDataUri(bytes, mimeFor(img.uri));
  }
}

function parseGltf(data: ArrayBuffer | string): Promise<LoadedGltf | null> {
  const loader = new GLTFLoader();
  return new Promise((resolve) => {
    loader.parse(
      data,
      "",
      (gltf: GLTF) => resolve({ scene: gltf.scene, animations: gltf.animations ?? [] }),
      () => resolve(null),
    );
  });
}

/**
 * Parsed assets, kept for the life of the window.
 *
 * A collision hull runs to hundreds of megabytes and several seconds of parse
 * time, and switching clips on one map would otherwise pay that every time.
 * Cached scenes carry `userData.cached` so `disposeObject` leaves their geometry
 * alone; freeing it would leave the cache holding dead GPU handles.
 */
const cache = new Map<string, LoadedGltf>();
const inflight = new Map<string, Promise<LoadedGltf | null>>();

function cacheKey(filePath: string) {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

export function isCachedAsset(obj: { userData?: Record<string, unknown> } | null | undefined) {
  return Boolean(obj?.userData?.cached);
}

/** Drop a parsed file so the next load reads disk (wave-2 agent re-export). */
export function invalidateGltfCache(filePath: string | null | undefined) {
  if (!filePath) return;
  const key = cacheKey(filePath);
  cache.delete(key);
  inflight.delete(key);
  cache.delete(filePath);
  inflight.delete(filePath);
}

export function loadGltfCached(filePath: string | null | undefined): Promise<LoadedGltf | null> {
  if (!filePath) return Promise.resolve(null);
  const key = cacheKey(filePath);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending;

  const job = loadUncached(filePath)
    .then((loaded) => {
      if (loaded) {
        loaded.scene.userData.cached = true;
        cache.set(key, loaded);
      }
      return loaded;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

function loadGlbFromUrl(url: string): Promise<LoadedGltf | null> {
  const loader = new GLTFLoader();
  return new Promise((resolve) => {
    loader.load(
      url,
      (gltf: GLTF) => resolve({ scene: gltf.scene, animations: gltf.animations ?? [] }),
      undefined,
      () => resolve(null),
    );
  });
}

async function loadUncached(filePath: string): Promise<LoadedGltf | null> {
  if (filePath.toLowerCase().endsWith(".glb")) {
    // Streamed through the reelmap:// handler rather than read into a Buffer and
    // shipped over IPC, which matters for the larger exports. Forward slashes
    // survive Chromium's custom-scheme decoder; backslash %5C often 404s.
    const url = `reelmap://asset/?path=${encodeURIComponent(filePath.replace(/\\/g, "/"))}`;
    const viaProtocol = await loadGlbFromUrl(url);
    if (viaProtocol) return viaProtocol;
  }
  if (!window.reel.readPreviewFile) return null;
  const raw = await window.reel.readPreviewFile(filePath);
  const bytes = asArrayBuffer(raw);
  if (!bytes) return null;
  if (isGlb(bytes)) return parseGltf(bytes);
  try {
    const json = JSON.parse(new TextDecoder().decode(bytes)) as {
      buffers?: { uri?: string }[];
      images?: { uri?: string }[];
    };
    await embedExternalUris(json, filePath);
    return parseGltf(JSON.stringify(json));
  } catch {
    return null;
  }
}
