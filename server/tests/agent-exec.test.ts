import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executePlan, undoPlan } from "../agent-exec.ts";
import { normalizePlan } from "../agent-plan.ts";
import { NoteStore } from "../store.ts";
import { Indexer } from "../indexer.ts";
import { openDb } from "../db.ts";
import { search } from "../search.ts";

function makeCtx() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "study-exec-"));
  const notesRoot = path.join(dataDir, "notes");
  fs.mkdirSync(notesRoot, { recursive: true });
  const store = new NoteStore({
    notesRoot,
    historyDir: path.join(dataDir, ".history"),
    trashDir: path.join(dataDir, ".trash"),
  });
  const db = openDb(path.join(dataDir, "index.db"));
  const indexer = new Indexer({ db, store });
  indexer.reindexAll();
  return {
    dataDir,
    notesRoot,
    store,
    db,
    indexer,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("createAt 落到指定路径且不 slugify", () => {
  const ctx = makeCtx();
  try {
    const note = ctx.store.createAt("backend-go/08-测试.md", { title: "测试", body: "# 测试" });
    assert.equal(note.relPath, "backend-go/08-测试.md");
    const raw = fs.readFileSync(path.join(ctx.notesRoot, "backend-go", "08-测试.md"), "utf8");
    assert.ok(raw.includes("title: 测试"));
    assert.ok(raw.includes("# 测试"));
  } finally {
    ctx.cleanup();
  }
});

test("createAt 撞已有路径抛错", () => {
  const ctx = makeCtx();
  try {
    ctx.store.createAt("a.md", { title: "A", body: "x" });
    assert.throws(() => ctx.store.createAt("a.md", { title: "A2", body: "y" }));
  } finally {
    ctx.cleanup();
  }
});

test("执行 create/append/rewrite/trash 四条结果都是 ok", () => {
  const ctx = makeCtx();
  try {
    const appendTarget = ctx.store.create({ title: "追加", body: "原有一行" });
    const rewriteTarget = ctx.store.create({ title: "重写", body: "旧内容" });
    const trashTarget = ctx.store.create({ title: "清掉", body: "要删的" });
    ctx.indexer.reindexAll();

    const plan = normalizePlan(
      {
        summary: "四连",
        ops: [
          { kind: "create", path: "backend-go/09-新增.md", title: "新增", body: "# 新增" },
          { kind: "append", path: appendTarget.relPath, text: "追加一行" },
          { kind: "rewrite", path: rewriteTarget.relPath, body: "全新内容" },
          { kind: "trash", path: trashTarget.relPath },
        ],
      },
      { store: ctx.store, notesRoot: ctx.notesRoot },
    );

    const { results } = executePlan({ store: ctx.store, indexer: ctx.indexer, dataDir: ctx.dataDir }, plan);
    assert.equal(results.length, 4);
    assert.deepEqual(
      results.map((r) => r.status),
      ["ok", "ok", "ok", "ok"],
    );
    assert.ok(fs.existsSync(path.join(ctx.notesRoot, "backend-go", "09-新增.md")));
    assert.ok(ctx.store.read(appendTarget.relPath).parsed.body.includes("追加一行"));
    assert.equal(ctx.store.read(rewriteTarget.relPath).parsed.body.trim(), "全新内容");
    assert.equal(fs.existsSync(ctx.store.absPath(trashTarget.relPath)), false);
  } finally {
    ctx.cleanup();
  }
});

test("执行时磁盘 hash 已变则跳过该条，其余照做", () => {
  const ctx = makeCtx();
  try {
    const changed = ctx.store.create({ title: "会被手改", body: "原文" });
    const other = ctx.store.create({ title: "照做", body: "原文" });
    const plan = normalizePlan(
      {
        summary: "s",
        ops: [
          { kind: "rewrite", path: changed.relPath, body: "计划里的新文" },
          { kind: "rewrite", path: other.relPath, body: "另一个新文" },
        ],
      },
      { store: ctx.store, notesRoot: ctx.notesRoot },
    );
    // 计划生成后，用户手改了第一篇
    const current = ctx.store.read(changed.relPath);
    ctx.store.save(changed.relPath, "用户手改过的正文", current.hash);

    const { results } = executePlan({ store: ctx.store, indexer: ctx.indexer, dataDir: ctx.dataDir }, plan);
    assert.equal(results[0].status, "conflict");
    assert.equal(results[1].status, "ok");
    assert.ok(ctx.store.read(changed.relPath).parsed.body.includes("用户手改过的正文"));
  } finally {
    ctx.cleanup();
  }
});

test("skip 生效", () => {
  const ctx = makeCtx();
  try {
    const a = ctx.store.create({ title: "A", body: "a" });
    const b = ctx.store.create({ title: "B", body: "b" });
    const plan = normalizePlan(
      {
        summary: "s",
        ops: [
          { kind: "rewrite", path: a.relPath, body: "A2" },
          { kind: "rewrite", path: b.relPath, body: "B2" },
        ],
      },
      { store: ctx.store, notesRoot: ctx.notesRoot },
    );
    const { results } = executePlan({ store: ctx.store, indexer: ctx.indexer, dataDir: ctx.dataDir }, plan, { skip: [1] });
    assert.equal(results.length, 1);
    assert.ok(ctx.store.read(a.relPath).parsed.body.includes("A2"));
    assert.ok(ctx.store.read(b.relPath).parsed.body.includes("b"));
  } finally {
    ctx.cleanup();
  }
});

test("执行前把受影响文件快照到 b-<planId>/", () => {
  const ctx = makeCtx();
  try {
    const note = ctx.store.create({ title: "快照", body: "原始正文" });
    const plan = normalizePlan(
      { summary: "s", ops: [{ kind: "rewrite", path: note.relPath, body: "新正文" }] },
      { store: ctx.store, notesRoot: ctx.notesRoot },
    );
    executePlan({ store: ctx.store, indexer: ctx.indexer, dataDir: ctx.dataDir }, plan);
    const batchDir = path.join(ctx.dataDir, ".history", "batches", `b-${plan.id}`);
    assert.ok(fs.existsSync(batchDir), "批次目录应存在");
    const files = fs.readdirSync(batchDir);
    assert.ok(files.length > 0);
    const raw = fs.readFileSync(path.join(batchDir, files[0]), "utf8");
    assert.ok(raw.includes("原始正文"));
  } finally {
    ctx.cleanup();
  }
});

test("undo 还原内容、把新建的移出库，并让索引一致", () => {
  const ctx = makeCtx();
  try {
    const note = ctx.store.create({ title: "要重写", body: "原始正文" });
    ctx.indexer.reindexAll();
    const plan = normalizePlan(
      {
        summary: "s",
        ops: [
          { kind: "rewrite", path: note.relPath, body: "改后的正文" },
          { kind: "create", path: "新建的.md", title: "新建的", body: "# 新建" },
        ],
      },
      { store: ctx.store, notesRoot: ctx.notesRoot },
    );
    executePlan({ store: ctx.store, indexer: ctx.indexer, dataDir: ctx.dataDir }, plan);
    assert.ok(search(ctx.db, "改后的正文").length >= 1, "执行后应能搜到新内容");

    const { restored, skipped } = undoPlan({ store: ctx.store, indexer: ctx.indexer, dataDir: ctx.dataDir }, plan);
    assert.equal(skipped.length, 0);
    assert.equal(restored, 2);
    assert.ok(ctx.store.read(note.relPath).parsed.body.includes("原始正文"));
    assert.equal(fs.existsSync(ctx.store.absPath("新建的.md")), false);
    assert.equal(search(ctx.db, "改后的正文").length, 0, "撤销后索引里不该再有新内容");
  } finally {
    ctx.cleanup();
  }
});

test("undo 在文件被后续改动时跳过该条并报告", () => {
  const ctx = makeCtx();
  try {
    const note = ctx.store.create({ title: "被后续改", body: "原始" });
    const plan = normalizePlan(
      { summary: "s", ops: [{ kind: "rewrite", path: note.relPath, body: "计划内容" }] },
      { store: ctx.store, notesRoot: ctx.notesRoot },
    );
    executePlan({ store: ctx.store, indexer: ctx.indexer, dataDir: ctx.dataDir }, plan);
    const after = ctx.store.read(note.relPath);
    ctx.store.save(note.relPath, "之后又被改了", after.hash);

    const { restored, skipped } = undoPlan({ store: ctx.store, indexer: ctx.indexer, dataDir: ctx.dataDir }, plan);
    assert.equal(restored, 0);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].path, note.relPath);
    assert.ok(ctx.store.read(note.relPath).parsed.body.includes("之后又被改了"));
  } finally {
    ctx.cleanup();
  }
});

test("trash 的 undo 用快照写回原路径", () => {
  const ctx = makeCtx();
  try {
    const note = ctx.store.create({ title: "别删我", body: "珍贵内容" });
    const plan = normalizePlan({ summary: "s", ops: [{ kind: "trash", path: note.relPath }] }, { store: ctx.store, notesRoot: ctx.notesRoot });
    executePlan({ store: ctx.store, indexer: ctx.indexer, dataDir: ctx.dataDir }, plan);
    assert.equal(fs.existsSync(ctx.store.absPath(note.relPath)), false);

    undoPlan({ store: ctx.store, indexer: ctx.indexer, dataDir: ctx.dataDir }, plan);
    assert.ok(ctx.store.read(note.relPath).parsed.body.includes("珍贵内容"));
  } finally {
    ctx.cleanup();
  }
});

test("0 字节笔记被移入回收站后，撤销能还原回来", async () => {
  const ctx = makeCtx();
  try {
    fs.writeFileSync(path.join(ctx.notesRoot, "empty.md"), "", "utf8");
    ctx.indexer.reindexAll();
    const plan = normalizePlan(
      { summary: "清理空文件", ops: [{ kind: "trash", path: "empty.md" }] },
      { store: ctx.store, notesRoot: ctx.notesRoot },
    );
    const { results } = executePlan({ store: ctx.store, indexer: ctx.indexer, dataDir: ctx.dataDir }, plan);
    assert.equal(results[0].status, "ok");
    assert.equal(fs.existsSync(path.join(ctx.notesRoot, "empty.md")), false);

    const undone = undoPlan({ store: ctx.store, indexer: ctx.indexer, dataDir: ctx.dataDir }, plan);
    assert.equal(undone.restored, 1, JSON.stringify(undone));
    assert.equal(fs.existsSync(path.join(ctx.notesRoot, "empty.md")), true);
  } finally {
    ctx.cleanup();
  }
});


// ---- 分组（执行时落盘） ----

test("带 group 的 create 执行后 frontmatter 里有 group", () => {
  const ctx = makeCtx();
  try {
    const plan = normalizePlan(
      { summary: "建一篇到 Go 学习", ops: [{ kind: "create", path: "go/01-接口.md", title: "接口", body: "正文", group: "Go 学习" }] },
      { store: ctx.store, notesRoot: ctx.notesRoot },
    );
    const result = executePlan({ store: ctx.store, indexer: ctx.indexer, dataDir: ctx.dataDir }, plan, {});
    assert.equal(result.results[0].status, "ok");
    assert.equal(ctx.store.read("go/01-接口.md").parsed.meta.group, "Go 学习");
  } finally {
    ctx.cleanup();
  }
});

test("带 group 的 append 会顺带改组；不带 group 的 append 保留原组", () => {
  const ctx = makeCtx();
  try {
    const note = ctx.store.create({ title: "已有", body: "原文", group: "旧组" });

    const plan = normalizePlan(
      { summary: "追加", ops: [{ kind: "append", path: note.relPath, text: "补一句" }] },
      { store: ctx.store, notesRoot: ctx.notesRoot },
    );
    executePlan({ store: ctx.store, indexer: ctx.indexer, dataDir: ctx.dataDir }, plan, {});
    assert.equal(ctx.store.read(note.relPath).parsed.meta.group, "旧组");

    const withGroup = normalizePlan(
      { summary: "追加并归组", ops: [{ kind: "append", path: note.relPath, text: "再补一句", group: "新组" }] },
      { store: ctx.store, notesRoot: ctx.notesRoot },
    );
    executePlan({ store: ctx.store, indexer: ctx.indexer, dataDir: ctx.dataDir }, withGroup, {});
    const after = ctx.store.read(note.relPath);
    assert.equal(after.parsed.meta.group, "新组");
    assert.ok(after.parsed.body.includes("再补一句"));
  } finally {
    ctx.cleanup();
  }
});


test("只改组的 rewrite 不碰 updated、不写历史", () => {
  const ctx = makeCtx();
  try {
    const note = ctx.store.create({ title: "只改组", body: "正文不变" });
    const before = ctx.store.read(note.relPath);
    const plan = normalizePlan(
      { summary: "归组", ops: [{ kind: "rewrite", path: note.relPath, body: "正文不变", group: "Go 学习" }] },
      { store: ctx.store, notesRoot: ctx.notesRoot },
    );
    executePlan({ store: ctx.store, indexer: ctx.indexer, dataDir: ctx.dataDir }, plan, {});
    const after = ctx.store.read(note.relPath);
    assert.equal(after.parsed.meta.group, "Go 学习");
    assert.equal(after.parsed.meta.updated, before.parsed.meta.updated, "只改分组不该顶 updated");
    // 批次快照（.history/plans/b-<planId>）是给撤销用的，允许；但每篇笔记的版本历史不该多一份\n    assert.equal(fs.existsSync(path.join(ctx.dataDir, ".history", note.id)), false, "只改分组不该写笔记版本历史");
  } finally {
    ctx.cleanup();
  }
});
