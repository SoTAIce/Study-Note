import { test } from "node:test";
import assert from "node:assert/strict";
import { diffIndexed, type IndexedShape } from "../index-diff.ts";

const base: IndexedShape = { title: "甲", type: "note", group: null, tags: ["a", "b"], links: ["乙"] };
const none = { title: false, tags: false, meta: false, links: false };

test("只改正文：什么都没变", () => {
  assert.deepEqual(diffIndexed(base, { ...base }), none);
});

test("标签、链接按集合比较：顺序和重复不算变化", () => {
  assert.deepEqual(diffIndexed(base, { ...base, tags: ["b", "a", "a"], links: ["乙", "乙"] }), none);
});

test("标题、标签、类型、分组、链接各自报告", () => {
  assert.deepEqual(diffIndexed(base, { ...base, title: "甲2" }), { ...none, title: true });
  assert.deepEqual(diffIndexed(base, { ...base, tags: ["a"] }), { ...none, tags: true });
  assert.deepEqual(diffIndexed(base, { ...base, tags: ["a", "c"] }), { ...none, tags: true });
  assert.deepEqual(diffIndexed(base, { ...base, type: "idea" }), { ...none, meta: true });
  assert.deepEqual(diffIndexed(base, { ...base, group: "工作" }), { ...none, meta: true });
  assert.deepEqual(diffIndexed(base, { ...base, links: [] }), { ...none, links: true });
});

test("以前没索引过：全部算变化", () => {
  assert.deepEqual(diffIndexed(null, base), { title: true, tags: true, meta: true, links: true });
});
