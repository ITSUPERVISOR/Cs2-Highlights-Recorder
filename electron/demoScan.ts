import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type DemoFile = { path: string };

type Snapshot = {
  mtimeMs: number;
  files: string[];
  dirs: string[];
};

const snapshots = new Map<string, Snapshot>();
let folderKey = "";

const MAX_DEPTH = 4;

export function isDemoFileName(name: string) {
  const lower = name.toLowerCase();
  return lower.endsWith(".dem") || lower.endsWith(".dem.gz") || lower.endsWith(".dem.zst");
}

export function clearDemoScanCache() {
  snapshots.clear();
  folderKey = "";
}

function normalize(filePath: string) {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

/**
 * Demos under the library folders.
 *
 * Each directory is stated once. If its modification time has not changed, the
 * previous listing is reused, so a refresh does not stat every demo file.
 * `fresh` forgets those listings, for an explicit Scan.
 */
export function listDemoFiles(folders: string[], fresh = false): DemoFile[] {
  if (fresh) snapshots.clear();
  const key = folders.map(normalize).sort().join("|");
  if (key !== folderKey) {
    snapshots.clear();
    folderKey = key;
  }
  const byPath = new Map<string, DemoFile>();
  for (const folder of folders) walk(folder, 0, byPath);
  return [...byPath.values()];
}

function walk(dir: string, depth: number, byPath: Map<string, DemoFile>) {
  if (depth > MAX_DEPTH) return;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(dir).mtimeMs;
  } catch {
    return;
  }
  const cached = snapshots.get(dir);
  if (cached && cached.mtimeMs === mtimeMs) {
    for (const file of cached.files) byPath.set(normalize(file), { path: file });
    for (const child of cached.dirs) walk(child, depth + 1, byPath);
    return;
  }

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const files: string[] = [];
  const dirs: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      dirs.push(full);
      continue;
    }
    if (entry.isSymbolicLink()) {
      let linked;
      try {
        linked = statSync(full);
      } catch {
        continue;
      }
      if (linked.isDirectory()) {
        dirs.push(full);
        continue;
      }
      if (linked.isFile() && isDemoFileName(entry.name)) files.push(full);
      continue;
    }
    if (entry.isFile() && isDemoFileName(entry.name)) files.push(full);
  }
  snapshots.set(dir, { mtimeMs, files, dirs });
  for (const file of files) byPath.set(normalize(file), { path: file });
  for (const child of dirs) walk(child, depth + 1, byPath);
}
