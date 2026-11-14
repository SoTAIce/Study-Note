import assert from "node:assert/strict";
import test from "node:test";
import { nextFocusIndex } from "./focus-trap.ts";

test("nextFocusIndex：Tab 往后走，到头回到第一个", () => {
  assert.equal(nextFocusIndex(3, 0, false), 1);
  assert.equal(nextFocusIndex(3, 2, false), 0);
});

test("nextFocusIndex：Shift+Tab 往前走，第一个回到最后", () => {
  assert.equal(nextFocusIndex(3, 1, true), 0);
  assert.equal(nextFocusIndex(3, 0, true), 2);
});

test("nextFocusIndex：焦点不在弹窗里时拉回第一个 / 最后一个；没有可聚焦元素返回 -1", () => {
  assert.equal(nextFocusIndex(3, -1, false), 0);
  assert.equal(nextFocusIndex(3, -1, true), 2);
  assert.equal(nextFocusIndex(0, -1, false), -1);
  assert.equal(nextFocusIndex(1, 0, false), 0);
});
