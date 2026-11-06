import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_GROUP_NAME,
  mergeGroupList,
  normalizeGroupName,
  readGroups,
  removeGroupEntry,
  renameGroupEntry,
  sameGroup,
  upsertGroup,
  validateGroupName,
  writeGroups,
} from "../groups.ts";

function mkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sn-groups-"));
}

test("normalizeGroupName 去首尾空白并把内部连续空白压成一个", () => {
  assert.equal(normalizeGroupName("  Go 学习  "), "Go 学习");
  assert.equal(normalizeGroupName("Go    学习"), "Go 学习");
  assert.equal(normalizeGroupName("Go\u3000\u3000学习"), "Go 学习");
  assert.equal(normalizeGroupName(""), "");
});

test("validateGroupName 拒绝空名、超长、非法字符和保留名", () => {
  assert.equal(validateGroupName("").ok, false);
  assert.equal(validateGroupName("   ").ok, false);
  assert.equal(validateGroupName("组".repeat(MAX_GROUP_NAME + 1)).ok, false);
  assert.equal(validateGroupName("Go/学习").ok, false);
  assert.equal(validateGroupName("Go:学习").ok, false);
  assert.equal(validateGroupName("Go\u0007学习").ok, false);
  assert.equal(validateGroupName("未分组").ok, false);
});

test("validateGroupName 通过时返回规范化后的名字", () => {
  const result = validateGroupName("  Agent   学习 ");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.name, "Agent 学习");
});

test("sameGroup 不区分大小写，空值与空串等价", () => {
  assert.equal(sameGroup("Go 学习", "go 学习"), true);
  assert.equal(sameGroup("Go 学习", "Go 学习2"), false);
  assert.equal(sameGroup(null, ""), true);
  assert.equal(sameGroup(undefined, null), true);
  assert.equal(sameGroup("不分组", null), false);
});

test("readGroups 在文件缺失或损坏时返回空数组而不是抛错", () => {
  const dir = mkDir();
  assert.deepEqual(readGroups(dir), []);

  fs.writeFileSync(path.join(dir, "groups.json"), "{ 坏掉的 json", "utf8");
  assert.deepEqual(readGroups(dir), []);

  fs.writeFileSync(path.join(dir, "groups.json"), JSON.stringify({ version: 1, groups: "nope" }), "utf8");
  assert.deepEqual(readGroups(dir), []);
});

test("writeGroups + readGroups 往返，upsertGroup 幂等且按顺序编号", () => {
  const dir = mkDir();
  const first = upsertGroup(dir, "Go 学习");
  assert.equal(first.created, true);
  assert.equal(first.entry.name, "Go 学习");
  assert.equal(first.entry.order, 1);

  const second = upsertGroup(dir, "go 学习");
  assert.equal(second.created, false);
  assert.equal(second.entry.name, "Go 学习");

  const third = upsertGroup(dir, "Agent 学习");
  assert.equal(third.entry.order, 2);

  assert.deepEqual(readGroups(dir), [
    { name: "Go 学习", order: 1 },
    { name: "Agent 学习", order: 2 },
  ]);
});

test("writeGroups 落盘形状是 { version: 1, groups }", () => {
  const dir = mkDir();
  writeGroups(dir, [{ name: "Go 学习", order: 1 }]);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "groups.json"), "utf8")) as {
    version: number;
    groups: Array<{ name: string; order: number }>;
  };
  assert.equal(raw.version, 1);
  assert.deepEqual(raw.groups, [{ name: "Go 学习", order: 1 }]);
});

test("renameGroupEntry 保序改名，撞名时合并而不是造出两个同组", () => {
  const dir = mkDir();
  upsertGroup(dir, "Go 学习");
  upsertGroup(dir, "Agent 学习");

  renameGroupEntry(dir, "go 学习", "Golang");
  assert.deepEqual(
    readGroups(dir).map((g) => g.name),
    ["Golang", "Agent 学习"],
  );

  // 撞名合并：顺序留目标那条，拼写统一成这次请求的名字（笔记里已经这么写了）
  renameGroupEntry(dir, "Golang", "agent  学习");
  assert.deepEqual(readGroups(dir).map((g) => g.name), ["agent 学习"]);
});

test("removeGroupEntry 删除后不再出现", () => {
  const dir = mkDir();
  upsertGroup(dir, "Go 学习");
  upsertGroup(dir, "Agent 学习");
  removeGroupEntry(dir, "go 学习");
  assert.deepEqual(readGroups(dir).map((g) => g.name), ["Agent 学习"]);
});

test("mergeGroupList 保留空组，并补上只在笔记里出现的组", () => {
  const merged = mergeGroupList(
    [{ name: "Go 学习", order: 1 }],
    ["go 学习", "Agent 学习", "Agent 学习"],
  );
  assert.deepEqual(merged, [
    { name: "Go 学习", order: 1, empty: false },
    { name: "Agent 学习", order: 2, empty: false },
  ]);

  const withEmpty = mergeGroupList([{ name: "Go 学习", order: 1 }], []);
  assert.deepEqual(withEmpty, [{ name: "Go 学习", order: 1, empty: true }]);
});
