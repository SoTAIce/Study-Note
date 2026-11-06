import { test } from "node:test";
import assert from "node:assert/strict";
import { canExecute, opLabel, planSummary } from "./plan-view.ts";

const OPS = [
  { index: 0, kind: "create" as const, path: "新建.md", title: "新建" },
  { index: 1, kind: "rewrite" as const, path: "改写.md", title: "改写" },
  { index: 2, kind: "append" as const, path: "追加.md", title: "追加" },
  { index: 3, kind: "trash" as const, path: "清理.md", title: "清理" },
];

test("统计各动作数量", () => {
  assert.deepEqual(planSummary(OPS), { creates: 1, rewrites: 1, appends: 1, trashes: 1, total: 4 });
});

test("有 trash 且未确认时不能执行", () => {
  assert.equal(canExecute(OPS, new Set(), false), false);
});

test("确认后可以执行", () => {
  assert.equal(canExecute(OPS, new Set(), true), true);
});

test("全部跳过时不能执行", () => {
  assert.equal(canExecute(OPS, new Set([0, 1, 2, 3]), true), false);
});

test("没有 trash 时不需要额外确认", () => {
  const noTrash = OPS.filter((op) => op.kind !== "trash");
  assert.equal(canExecute(noTrash, new Set(), false), true);
});

test("跳过所有 trash 后也不再需要确认", () => {
  assert.equal(canExecute(OPS, new Set([3]), false), true);
});

test("动作标签带符号与文件名", () => {
  assert.equal(opLabel(OPS[0]), "＋ 新建.md");
  assert.equal(opLabel(OPS[1]), "✎ 改写.md");
  assert.equal(opLabel(OPS[2]), "✎ 追加.md");
  assert.equal(opLabel(OPS[3]), "✗ 清理.md");
});
