import assert from "node:assert/strict";
import test from "node:test";
import { previewWindow } from "../src/renderer/src/lib/previewWindow.ts";

test("preview window matches the lead-in and lead-out around a clip", () => {
  assert.deepEqual(previewWindow({ firstTick: 1000, lastTick: 1200 }, 64), { start: 744, end: 1392 });
});

test("preview window never starts before the safe tick", () => {
  assert.deepEqual(previewWindow({ firstTick: 100, lastTick: 200 }, 64), { start: 96, end: 392 });
});

test("an empty clip has no window", () => {
  assert.equal(previewWindow({ firstTick: 1000, lastTick: 0 }, 1), null);
});
