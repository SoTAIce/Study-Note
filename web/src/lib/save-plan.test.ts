import assert from "node:assert/strict";
import test from "node:test";
import type { NoteChange } from "./live.ts";
import {
  AUTOSAVE_IDLE_MS,
  AUTOSAVE_MAX_WAIT_MS,
  autosaveDelay,
  dropOwnEchoes,
  echoKey,
  patchTimeline,
  refreshAfterSave,
} from "./save-plan.ts";

const none = { title: false, tags: false, meta: false, links: false };

test("只改正文：保存后左栏和反链都不刷新", () => {
  assert.deepEqual(refreshAfterSave(none), { sidebar: false, backlinks: false });
});

test("标签 / 类型分组变了只刷新左栏；链接变了只刷新反链；标题变了两个都刷新", () => {
  assert.deepEqual(refreshAfterSave({ ...none, tags: true }), { sidebar: true, backlinks: false });
  assert.deepEqual(refreshAfterSave({ ...none, meta: true }), { sidebar: true, backlinks: false });
  assert.deepEqual(refreshAfterSave({ ...none, links: true }), { sidebar: false, backlinks: true });
  assert.deepEqual(refreshAfterSave({ ...none, title: true }), { sidebar: true, backlinks: true });
});

test("服务端没给 changes 时保守地全部刷新", () => {
  assert.deepEqual(refreshAfterSave(undefined), { sidebar: true, backlinks: true });
});

test("自动保存：停手 5 秒才存；一直在打字最多 30 秒存一次", () => {
  assert.equal(AUTOSAVE_IDLE_MS, 5_000);
  assert.equal(AUTOSAVE_MAX_WAIT_MS, 30_000);
  assert.equal(autosaveDelay(1_000, null), 5_000);
  assert.equal(autosaveDelay(1_000, 0), 5_000);
  assert.equal(autosaveDelay(27_000, 0), 3_000);
  assert.equal(autosaveDelay(40_000, 0), 0);
});

test("回声：自己保存过的那一版被滤掉，别处的变化和删除保留", () => {
  const own = new Set([echoKey("a", "h1")]);
  const changes: NoteChange[] = [
    { kind: "changed", id: "a", path: "a.md", hash: "h1" },
    { kind: "changed", id: "a", path: "a.md", hash: "h2" },
    { kind: "changed", id: "b", path: "b.md", hash: "h1" },
    { kind: "removed", id: "a", path: "a.md" },
  ];
  assert.deepEqual(dropOwnEchoes(changes, own), changes.slice(1));
  assert.deepEqual(dropOwnEchoes([changes[0]], own), []);
});

test("时间线就地更新；没变化时返回同一个数组", () => {
  const items = [
    { id: "a", title: "甲", updated: "1", relPath: "a.md", type: "note" },
    { id: "b", title: "乙", updated: "1", relPath: "b.md", type: "note" },
  ];
  const next = patchTimeline(items, { id: "a", title: "甲", updated: "2", relPath: "a.md" });
  assert.equal(next[0].updated, "2");
  assert.equal(next[0].type, "note");
  assert.equal(next[1], items[1]);
  assert.equal(patchTimeline(next, { id: "a", title: "甲", updated: "2", relPath: "a.md" }), next);
  assert.equal(patchTimeline(items, { id: "x", title: "?", updated: "9", relPath: "x.md" }), items);
});
