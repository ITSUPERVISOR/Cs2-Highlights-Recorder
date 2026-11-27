import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { clearDemoScanCache, isDemoFileName, listDemoFiles } from "./demoScan.ts";

function names(files: { path: string }[]) {
  return files.map((file) => file.path.split(/[/\\]/).pop()).sort();
}

test("demo names cover compressed replays and ignore other files", () => {
  assert.equal(isDemoFileName("match.dem"), true);
  assert.equal(isDemoFileName("match.DEM.GZ"), true);
  assert.equal(isDemoFileName("match.dem.zst"), true);
  assert.equal(isDemoFileName("notes.txt"), false);
  assert.equal(isDemoFileName("config.cfg"), false);
});

test("a scan finds demos without stating every file, and a refresh sees a new one", () => {
  const root = mkdtempSync(join(tmpdir(), "reel-demos-"));
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "a.dem"), "a");
  writeFileSync(join(root, "skip.txt"), "nope");
  writeFileSync(join(root, "sub", "b.dem.gz"), "b");
  let deep = root;
  for (let i = 0; i < 6; i += 1) {
    deep = join(deep, `d${i}`);
    mkdirSync(deep);
  }
  writeFileSync(join(deep, "too-deep.dem"), "x");

  clearDemoScanCache();
  assert.deepEqual(names(listDemoFiles([root])), ["a.dem", "b.dem.gz"]);

  const cached = names(listDemoFiles([root]));
  assert.deepEqual(cached, ["a.dem", "b.dem.gz"]);

  const created = join(root, "c.dem.zst");
  writeFileSync(created, "c");
  const now = new Date();
  utimesSync(root, now, now);
  assert.deepEqual(names(listDemoFiles([root])), ["a.dem", "b.dem.gz", "c.dem.zst"]);
});
