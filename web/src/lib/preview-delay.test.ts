import { test } from "node:test";
import assert from "node:assert/strict";
import { previewDelay } from "./preview-delay.ts";

test("previewDelay：短笔记立即，长笔记等停手", () => {
  assert.equal(previewDelay(0), 0);
  assert.equal(previewDelay(7_999), 0);
  assert.equal(previewDelay(8_000), 150);
  assert.equal(previewDelay(39_999), 150);
  assert.equal(previewDelay(40_000), 400);
  assert.equal(previewDelay(500_000), 400);
});
