import assert from "node:assert/strict";
import test from "node:test";
import { isScreenVisible } from "./screen-visibility.ts";

test("只有目标页面与当前页面相同时才显示，切走时仅隐藏", () => {
  assert.equal(isScreenVisible("ai", "ai"), true);
  assert.equal(isScreenVisible("notes", "ai"), false);
  assert.equal(isScreenVisible("trash", "notes"), false);
  assert.equal(isScreenVisible("notes", "notes"), true);
});
