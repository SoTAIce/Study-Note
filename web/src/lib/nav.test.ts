import { test } from "node:test";
import assert from "node:assert/strict";
import { filterLabel, sameFilter } from "./nav.ts";

test("filterLabel 认识分组与未分组", () => {
  assert.equal(filterLabel({ kind: "group", name: "Go 学习" }), "Go 学习");
  assert.equal(filterLabel({ kind: "none" }), "未分组");
  assert.equal(filterLabel({ kind: "all" }), "全部笔记");
});

test("sameFilter 对分组比较组名", () => {
  assert.equal(sameFilter({ kind: "group", name: "A" }, { kind: "group", name: "A" }), true);
  assert.equal(sameFilter({ kind: "group", name: "A" }, { kind: "group", name: "B" }), false);
  assert.equal(sameFilter({ kind: "none" }, { kind: "none" }), true);
  assert.equal(sameFilter({ kind: "none" }, { kind: "group", name: "A" }), false);
  // 组名大小写不同 = 同一个组（服务端也不区分）
  assert.equal(sameFilter({ kind: "group", name: "go 学习" }, { kind: "group", name: "Go 学习" }), true);
});

test("sameFilter 区分不同类型的筛选", () => {
  assert.equal(sameFilter({ kind: "all" }, { kind: "inbox" }), false);
  assert.equal(sameFilter({ kind: "tag", tag: "go" }, { kind: "tag", tag: "go" }), true);
  assert.equal(sameFilter({ kind: "day", day: "2026-11-02" }, { kind: "day", day: "2026-11-02" }), true);
});
