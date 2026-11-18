import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGroupTree,
  isInGroup,
  leafName,
  parentOf,
  readCollapsedGroups,
  replacePrefix,
  writeCollapsedGroups,
} from "./group-tree.ts";

const g = (name: string, count = 1) => ({ name, count, total: count, empty: false });

test("parentOf / leafName", () => {
  assert.equal(parentOf("agent/looprun"), "agent");
  assert.equal(parentOf("agent"), null);
  assert.equal(leafName("agent/looprun"), "looprun");
  assert.equal(leafName("agent"), "agent");
});

test("isInGroup 不区分大小写，名字相近的别组不算", () => {
  assert.equal(isInGroup("Agent/looprun", "agent"), true);
  assert.equal(isInGroup("agent", "AGENT"), true);
  assert.equal(isInGroup("agents/x", "agent"), false);
  assert.equal(isInGroup(null, "agent"), false);
});

test("replacePrefix 只换在 from 下面的", () => {
  assert.equal(replacePrefix("agent/looprun", "agent", "ai"), "ai/looprun");
  assert.equal(replacePrefix("agent", "agent", "ai"), "ai");
  assert.equal(replacePrefix("other", "agent", "ai"), "other");
});

test("buildGroupTree 保持顺序，把子项目挂到父分组下", () => {
  const tree = buildGroupTree([g("课程"), g("agent/trace"), g("agent"), g("agent/looprun")]);
  assert.deepEqual(
    tree.map((node) => [node.group.name, node.children.map((child) => child.name)]),
    [
      ["课程", []],
      ["agent", ["agent/trace", "agent/looprun"]],
    ],
  );
});

test("buildGroupTree 父分组缺失时补一个空壳", () => {
  const tree = buildGroupTree([g("孤父/子")]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].group.name, "孤父");
  assert.deepEqual(tree[0].children.map((child) => child.name), ["孤父/子"]);
});

test("折叠状态读写往返；坏数据或存储抛错时当全部展开", () => {
  const map = new Map<string, string>();
  const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
  writeCollapsedGroups(storage, new Set(["agent"]));
  assert.deepEqual([...readCollapsedGroups(storage)], ["agent"]);
  map.set("study.groupTreeCollapsed", "{坏的");
  assert.equal(readCollapsedGroups(storage).size, 0);
  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(readCollapsedGroups(throwing).size, 0);
  writeCollapsedGroups(throwing, new Set(["x"]));
});
