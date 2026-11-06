import assert from "node:assert/strict";
import test from "node:test";
import { closeNoteTab, renameNoteTab, upsertNoteTab, type NoteTab } from "./note-tabs.ts";

const tabs: NoteTab[] = [
  { id: "a", title: "Alpha" },
  { id: "b", title: "Beta" },
  { id: "c", title: "Gamma" },
];

test("重复打开同一笔记只更新标题，不新增标签或改变顺序", () => {
  assert.deepEqual(upsertNoteTab(tabs, { id: "b", title: "Beta 2" }), [
    tabs[0],
    { id: "b", title: "Beta 2" },
    tabs[2],
  ]);
});

test("编辑标题时只改对应标签", () => {
  assert.deepEqual(renameNoteTab(tabs, "b", "新标题"), [tabs[0], { id: "b", title: "新标题" }, tabs[2]]);
});

test("关闭当前标签优先激活右侧，没有右侧时激活左侧", () => {
  assert.deepEqual(closeNoteTab(tabs, "b", "b"), {
    tabs: [tabs[0], tabs[2]],
    nextActiveId: "c",
  });
  assert.deepEqual(closeNoteTab(tabs, "c", "c"), {
    tabs: [tabs[0], tabs[1]],
    nextActiveId: "b",
  });
  assert.deepEqual(closeNoteTab([tabs[0]], "a", "a"), {
    tabs: [],
    nextActiveId: null,
  });
});

test("关闭非当前标签保持当前标签不变", () => {
  assert.deepEqual(closeNoteTab(tabs, "a", "c"), {
    tabs: [tabs[1], tabs[2]],
    nextActiveId: "c",
  });
});
