import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NoteStore, ConflictError, HistoryNotFoundError } from "../store.ts";
import { isValidVersionId, makeVersionId, parseVersionId, planPrune, type HistoryReason } from "../history.ts";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function mkStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sn-hist-"));
  const clock = { t: new Date(2026, 10, 1, 9, 0, 0).getTime() };
  const store = new NoteStore({
    notesRoot: path.join(root, "notes"),
    historyDir: path.join(root, "history"),
    trashDir: path.join(root, "trash"),
    now: () => new Date(clock.t),
  });
  const advance = (ms: number): void => {
    clock.t += ms;
  };
  return { store, root, clock, advance };
}

test("10 分钟内的连续保存只存一份；超过 10 分钟再存", () => {
  const { store, advance } = mkStore();
  let n = store.create({ title: "合并", body: "v0" });
  for (let i = 1; i <= 5; i++) {
    advance(MIN);
    n = store.save(n.relPath, `v${i}`, n.hash);
  }
  assert.equal(store.listHistory(n.id).length, 1);
  advance(11 * MIN);
  n = store.save(n.relPath, "v6", n.hash);
  const list = store.listHistory(n.id);
  assert.equal(list.length, 2);
  assert.equal(store.readVersion(n.id, list[0].versionId).body, "v5", "新的一份是被覆盖前的 v5");
  assert.equal(store.readVersion(n.id, list[1].versionId).body, "v0");
});

test("带 checkpoint 的保存一定存，并记下来源", () => {
  const { store, advance } = mkStore();
  let n = store.create({ title: "存档点", body: "a" });
  n = store.save(n.relPath, "b", n.hash, {}, { checkpoint: "edit" });
  advance(1000);
  n = store.save(n.relPath, "c", n.hash, {}, { checkpoint: "ai" });
  const list = store.listHistory(n.id);
  assert.deepEqual(
    list.map((item) => item.reason),
    ["ai", "edit"],
  );
  assert.equal(store.readVersion(n.id, list[0].versionId).body, "b");
});

test("和最近一份内容完全相同时不重复存", () => {
  const { store, advance } = mkStore();
  const n = store.create({ title: "去重", body: "A" });
  advance(1000);
  const b = store.save(n.relPath, "B", n.hash, {}, { checkpoint: "edit" });
  assert.equal(store.listHistory(n.id).length, 1);
  // 外部把文件改回 A 的原文：再存时要拍的内容就和最近一份快照一模一样
  fs.writeFileSync(path.join(store.notesRoot, b.relPath), n.raw, "utf8");
  const reverted = store.read(b.relPath);
  advance(1000);
  store.save(reverted.relPath, "C", reverted.hash, {}, { checkpoint: "edit" });
  assert.equal(store.listHistory(n.id).length, 1);
});

test("恢复：正文/标题/标签回去，分组与 created 保留，并多一份 restore 快照", () => {
  const { store, advance } = mkStore();
  let n = store.create({ title: "原标题", body: "原文 #旧标签", group: "前端" });
  const created = n.parsed.meta.created;
  advance(MIN);
  n = store.save(n.relPath, "改过的正文", n.hash, { title: "新标题", tags: ["新"] }, { checkpoint: "edit" });
  const [version] = store.listHistory(n.id);
  advance(MIN);
  const restored = store.restoreVersion(n.relPath, version.versionId, n.hash);
  assert.equal(restored.parsed.body, "原文 #旧标签");
  assert.equal(restored.parsed.meta.title, "原标题");
  assert.deepEqual(restored.parsed.meta.tags, ["旧标签"]);
  assert.equal(restored.parsed.meta.group, "前端");
  assert.equal(restored.parsed.meta.created, created);
  assert.equal(restored.id, n.id);
  const list = store.listHistory(n.id);
  assert.equal(list[0].reason, "restore");
  assert.equal(store.readVersion(n.id, list[0].versionId).body, "改过的正文", "恢复前的内容能找回来");
});

test("恢复时 baseHash 过期抛 ConflictError，文件不变", () => {
  const { store, advance } = mkStore();
  let n = store.create({ title: "冲突", body: "一" });
  advance(MIN);
  n = store.save(n.relPath, "二", n.hash, {}, { checkpoint: "edit" });
  const [version] = store.listHistory(n.id);
  assert.throws(() => store.restoreVersion(n.relPath, version.versionId, "0".repeat(64)), ConflictError);
  assert.equal(store.read(n.relPath).parsed.body, "二");
});

test("不存在 / 非法的版本 ID", () => {
  const { store } = mkStore();
  const n = store.create({ title: "x", body: "y" });
  assert.throws(() => store.readVersion(n.id, "20260101T000000-001-abcd.edit"), HistoryNotFoundError);
  assert.throws(() => store.readVersion(n.id, "../../secret"), /版本 ID 不合法/);
  assert.throws(() => store.readVersion("../x", "20260101T000000-001-abcd.edit"), /不合法/);
  assert.deepEqual(store.listHistory(n.id), []);
});

test("旧格式文件名能读，来源当作 edit", () => {
  const { store } = mkStore();
  const n = store.create({ title: "旧", body: "旧正文" });
  const dir = path.join(store.historyDir, n.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "20261030100000080-001-ab12.md"), n.raw, "utf8");
  const list = store.listHistory(n.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].reason, "edit");
  assert.equal(store.readVersion(n.id, list[0].versionId).body, "旧正文");
});

test("版本 ID 校验与解析", () => {
  const id = makeVersionId(new Date(2026, 10, 12, 22, 47, 49), 1, "ab12", "ai");
  assert.equal(id, "20261112T224749-001-ab12.ai");
  assert.ok(isValidVersionId(id));
  assert.equal(parseVersionId(id)?.reason, "ai");
  assert.equal(parseVersionId(id)?.takenAt, new Date(2026, 10, 12, 22, 47, 49).getTime());
  assert.ok(isValidVersionId("20261030100000080-001-ab12"));
  for (const bad of ["../x", "20261112T224749-001-ab12.evil", "20261112T224749-001-ab12.md/..", ""]) {
    assert.equal(isValidVersionId(bad), false, bad);
  }
});

function fake(takenAt: number, reason: HistoryReason = "edit", bytes = 100) {
  const id = makeVersionId(new Date(takenAt), 1, Math.floor(takenAt / 1000).toString(16).slice(-4).padStart(4, "0"), reason);
  return { ...parseVersionId(id)!, bytes };
}

test("稀疏：24 小时内全留；7 天内每小时一份；90 天内每天一份；更早每周一份", () => {
  const now = new Date(2026, 10, 12, 12, 0, 0).getTime();
  const versions = [
    // 24h 内：每 10 分钟一份，共 6 份，全留
    ...Array.from({ length: 6 }, (_, i) => fake(now - (i + 1) * 10 * MIN)),
    // 2 天前同一小时内 3 份 → 留 1
    fake(now - 2 * DAY + 1 * MIN),
    fake(now - 2 * DAY + 2 * MIN),
    fake(now - 2 * DAY + 3 * MIN),
    // 30 天前同一天 3 份 → 留 1
    fake(now - 30 * DAY + 1 * HOUR),
    fake(now - 30 * DAY + 2 * HOUR),
    fake(now - 30 * DAY + 3 * HOUR),
  ];
  const drop = new Set(planPrune(versions, now));
  assert.equal(drop.size, 4);
  const kept = versions.filter((v) => !drop.has(v.versionId));
  assert.equal(kept.length, 8);
  // 每个桶留下的是最新的那份
  assert.ok(kept.some((v) => v.takenAt === now - 2 * DAY + 3 * MIN));
  assert.ok(kept.some((v) => v.takenAt === now - 30 * DAY + 3 * HOUR));
});

test("稀疏：restore 来源 7 天内不被合并", () => {
  const now = new Date(2026, 10, 12, 12, 0, 0).getTime();
  const versions = [fake(now - 3 * DAY + MIN, "restore"), fake(now - 3 * DAY + 2 * MIN, "restore")];
  assert.deepEqual(planPrune(versions, now), []);
});

test("稀疏：超过份数或总大小上限时从最旧的删", () => {
  const now = new Date(2026, 10, 12, 12, 0, 0).getTime();
  const versions = Array.from({ length: 10 }, (_, i) => fake(now - (i + 1) * MIN, "edit", 100));
  const byCount = planPrune(versions, now, { maxVersions: 7 });
  assert.equal(byCount.length, 3);
  assert.ok(byCount.includes(versions[9].versionId), "最旧的先删");
  const bySize = planPrune(versions, now, { maxBytes: 450 });
  assert.equal(bySize.length, 6);
});

test("真实保存会触发稀疏：跨天后的旧版本被合并", () => {
  const { store, advance } = mkStore();
  let n = store.create({ title: "跨天", body: "0" });
  // 第一天每隔 11 分钟存一次，存 6 份（同一小时内落 5~6 份）
  for (let i = 1; i <= 6; i++) {
    advance(11 * MIN);
    n = store.save(n.relPath, String(i), n.hash);
  }
  assert.equal(store.listHistory(n.id).length, 6);
  advance(3 * DAY);
  n = store.save(n.relPath, "后来", n.hash);
  // 3 天前的 6 份按小时合并：9:11~10:06 跨两个小时 → 留 2 份，加上新的一份
  assert.equal(store.listHistory(n.id).length, 3);
});
