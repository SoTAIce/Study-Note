import { test } from "node:test";
import assert from "node:assert/strict";
import { lineStarts, mapScroll } from "./scroll-sync.ts";

test("mapScroll：锚点上对齐，锚点之间按比例", () => {
  const e = [100, 300, 500];
  const p = [200, 260, 900];
  assert.equal(mapScroll(e, p, 0, 1000, 2000), 0);
  assert.equal(mapScroll(e, p, 100, 1000, 2000), 200);
  assert.equal(mapScroll(e, p, 200, 1000, 2000), 230);
  assert.equal(mapScroll(e, p, 50, 1000, 2000), 100);
  assert.equal(mapScroll(e, p, 750, 1000, 2000), 1450);
});

test("mapScroll：滚到底预览也到底；编辑区不能滚时为 0", () => {
  assert.equal(mapScroll([100], [100], 1000, 1000, 1234), 1234);
  assert.equal(mapScroll([100], [100], 0, 0, 500), 0);
});

test("mapScroll：不单调的锚点被跳过，结果不超出范围", () => {
  const value = mapScroll([100, 80, 300], [100, 150, 120], 200, 400, 300);
  assert.ok(value >= 100 && value <= 300, String(value));
  assert.equal(mapScroll([5000], [5000], 300, 400, 300), 225);
});

test("lineStarts", () => {
  assert.deepEqual(lineStarts("a\nbc\n\nd"), [0, 2, 5, 6]);
  assert.deepEqual(lineStarts(""), [0]);
});
