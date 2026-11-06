import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTools, resolveInside, ToolError } from "../agent-tools.ts";
import { openDb } from "../db.ts";
import { NoteStore } from "../store.ts";
import { Indexer } from "../indexer.ts";
import { search } from "../search.ts";

type Ctx = {
  dataDir: string;
  notesRoot: string;
  store: NoteStore;
  db: ReturnType<typeof openDb>;
  indexer: Indexer;
  cleanup: () => void;
};

function makeCtx(readRoots?: string[]): Ctx {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "study-tools-"));
  const notesRoot = path.join(dataDir, "notes");
  fs.mkdirSync(notesRoot, { recursive: true });
  const store = new NoteStore({
    notesRoot,
    historyDir: path.join(dataDir, ".history"),
    trashDir: path.join(dataDir, ".trash"),
  });
  const db = openDb(path.join(dataDir, "index.db"));
  const indexer = new Indexer({ db, store });
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

test("list_notes 返回库内笔记摘要", async () => {
  const ctx = makeCtx();
  try {
    ctx.store.create({ title: "第一篇", body: "# 一", tags: ["go"] });
    ctx.store.create({ title: "第二篇", body: "# 二" });
    ctx.indexer.reindexAll();
    const tools = createTools({ db: ctx.db, store: ctx.store, notesRoot: ctx.notesRoot, readRoots: [ctx.notesRoot] });
    const result = await tools.run("list_notes", {});
    const parsed = JSON.parse(result.content) as Array<{ path: string; title: string; updated: string }>;
    assert.equal(parsed.length, 2);
    assert.ok(parsed.every((item) => item.path.endsWith(".md")));
    assert.ok(parsed.some((item) => item.title === "第一篇"));
    assert.ok(result.summary.length > 0);
  } finally {
    ctx.cleanup();
  }
});

test("search_notes 命中正文", async () => {
  const ctx = makeCtx();
  try {
    ctx.store.create({ title: "路由", body: "这里讲 Gin 中间件 的注册顺序" });
    ctx.indexer.reindexAll();
    const tools = createTools({ db: ctx.db, store: ctx.store, notesRoot: ctx.notesRoot, readRoots: [ctx.notesRoot] });
    const result = await tools.run("search_notes", { query: "中间件" });
    const hits = JSON.parse(result.content) as Array<{ path: string; snippet: string }>;
    assert.equal(hits.length, 1);
    assert.ok(hits[0].snippet.includes("中间件"));
    // 顺带确认索引真的可用（不是碰运气）
    assert.ok(search(ctx.db, "中间件").length >= 1);
  } finally {
    ctx.cleanup();
  }
});

test("read_note 返回 body 与 hash，超长截断并标注", async () => {
  const ctx = makeCtx();
  try {
    const created = ctx.store.create({ title: "长文", body: "字".repeat(60_000) });
    const tools = createTools({ db: ctx.db, store: ctx.store, notesRoot: ctx.notesRoot, readRoots: [ctx.notesRoot] });
    const result = await tools.run("read_note", { path: created.relPath });
    const note = JSON.parse(result.content) as { body: string; hash: string };
    assert.ok(note.hash.length > 0);
    assert.ok(note.body.length <= 40_000 + 200);
    assert.ok(note.body.includes("〔已截断"));
  } finally {
    ctx.cleanup();
  }
});

test("read_file 只读白名单目录", async () => {
  const ctx = makeCtx();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "study-outside-"));
  try {
    fs.writeFileSync(path.join(ctx.notesRoot, "a.md"), "# ok", "utf8");
    fs.writeFileSync(path.join(outside, "secret.txt"), "秘密", "utf8");
    const tools = createTools({ db: ctx.db, store: ctx.store, notesRoot: ctx.notesRoot, readRoots: [ctx.notesRoot] });
    const ok = await tools.run("read_file", { path: "a.md" });
    assert.ok(ok.content.includes("# ok"));
    const denied = await tools.run("read_file", { path: path.join(outside, "secret.txt") });
    assert.ok(denied.content.includes("错误"));
    assert.ok(!denied.content.includes("秘密"));
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    ctx.cleanup();
  }
});

test("路径穿越被拒", () => {
  const ctx = makeCtx();
  try {
    assert.throws(() => resolveInside(ctx.notesRoot, "../secret.md"), (err: unknown) => (err as ToolError).code === "BAD_PATH");
    assert.throws(() => resolveInside(ctx.notesRoot, "C:\\Windows\\win.ini"), (err: unknown) => (err as ToolError).code === "BAD_PATH");
    assert.throws(() => resolveInside(ctx.notesRoot, "a/../../b.md"), (err: unknown) => (err as ToolError).code === "BAD_PATH");
  } finally {
    ctx.cleanup();
  }
});

test("read_dir 跳过 node_modules 与 .git", async () => {
  const ctx = makeCtx();
  try {
    const dir = path.join(ctx.notesRoot, "src");
    fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "x", "y.js"), "x");
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "x");
    fs.writeFileSync(path.join(dir, "main.go"), "package main");
    const tools = createTools({ db: ctx.db, store: ctx.store, notesRoot: ctx.notesRoot, readRoots: [ctx.notesRoot] });
    const result = await tools.run("read_dir", { path: "src" });
    assert.ok(result.content.includes("main.go"));
    assert.ok(!result.content.includes("node_modules"));
    assert.ok(!result.content.includes(".git"));
  } finally {
    ctx.cleanup();
  }
});

test("坏参数不抛出未捕获异常，返回错误文本", async () => {
  const ctx = makeCtx();
  try {
    const tools = createTools({ db: ctx.db, store: ctx.store, notesRoot: ctx.notesRoot, readRoots: [ctx.notesRoot] });
    const result = await tools.run("read_note", {});
    assert.ok(result.content.includes("参数错误"));
  } finally {
    ctx.cleanup();
  }
});

test("list_notes 的 tag 过滤不区分大小写", async () => {
  const ctx = makeCtx();
  try {
    ctx.store.create({ title: "Go 笔记", body: "# go", tags: ["go"] });
    ctx.store.create({ title: "别的", body: "# x", tags: ["rust"] });
    ctx.indexer.reindexAll();
    const tools = createTools({ db: ctx.db, store: ctx.store, notesRoot: ctx.notesRoot, readRoots: [ctx.notesRoot] });
    const upper = JSON.parse((await tools.run("list_notes", { tag: "Go" })).content) as Array<{ title: string }>;
    assert.equal(upper.length, 1);
    assert.equal(upper[0].title, "Go 笔记");
  } finally {
    ctx.cleanup();
  }
});

test("加了别的白名单目录后，笔记库仍然可读（不会被顶掉）", async () => {
  const ctx = makeCtx();
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), "study-extra-"));
  try {
    fs.writeFileSync(path.join(extra, "hello.txt"), "外部内容", "utf8");
    ctx.store.create({ title: "库内笔记", body: "# 库内" });
    ctx.indexer.reindexAll();
    const tools = createTools({
      db: ctx.db,
      store: ctx.store,
      notesRoot: ctx.notesRoot,
      readRoots: [extra],
    });
    const inside = await tools.run("read_file", { path: "库内笔记.md" });
    assert.ok(inside.content.includes("库内"), `应能读到笔记库，实际：${inside.content.slice(0, 80)}`);
    const outside = await tools.run("read_file", { path: path.join(extra, "hello.txt") });
    assert.ok(outside.content.includes("外部内容"));
  } finally {
    fs.rmSync(extra, { recursive: true, force: true });
    ctx.cleanup();
  }
});

test("白名单指向 data/ 时也读不到 config.json（key 不能被 AI 看见）", async () => {
  const ctx = makeCtx();
  try {
    fs.writeFileSync(path.join(ctx.dataDir, "config.json"), JSON.stringify({ apiKey: "sk-SECRET-KEY" }), "utf8");
    const tools = createTools({
      db: ctx.db,
      store: ctx.store,
      notesRoot: ctx.notesRoot,
      readRoots: [ctx.dataDir],
      dataDir: ctx.dataDir,
    });
    const result = await tools.run("read_file", { path: "config.json" });
    assert.ok(!result.content.includes("sk-SECRET-KEY"), "不该把明文 key 交给模型");
    assert.ok(result.content.startsWith("错误"), result.content.slice(0, 80));
  } finally {
    ctx.cleanup();
  }
});

test("junction 不能绕过白名单（读与写都挡住）", async (t) => {
  const ctx = makeCtx();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "study-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "secret.txt"), "SECRET-CONTENT", "utf8");
    const link = path.join(ctx.notesRoot, "j");
    try {
      fs.symlinkSync(outside, link, "junction");
    } catch {
      t.skip("当前环境不允许建 junction");
      return;
    }
    const tools = createTools({
      db: ctx.db,
      store: ctx.store,
      notesRoot: ctx.notesRoot,
      readRoots: [ctx.notesRoot],
      dataDir: ctx.dataDir,
    });
    const viaTool = await tools.run("read_file", { path: "j/secret.txt" });
    assert.ok(!viaTool.content.includes("SECRET-CONTENT"), `读越界了：${viaTool.content.slice(0, 80)}`);

    assert.throws(() => ctx.store.createAt("j/evil.md", { body: "x" }), /越界/);
    assert.equal(fs.existsSync(path.join(outside, "evil.md")), false);
  } finally {
    try {
      fs.rmSync(path.join(ctx.notesRoot, "j"), { force: true });
    } catch {
      /* junction 可能已被删 */
    }
    fs.rmSync(outside, { recursive: true, force: true });
    ctx.cleanup();
  }
});


// ---- 分组（工具） ----

test("list_notes 可以按组过滤，group=none 只列未分组", async () => {
  const ctx = makeCtx();
  try {
    const go = ctx.store.create({ title: "Go 接口", body: "正文", group: "Go 学习" });
    const agent = ctx.store.create({ title: "Agent 计划", body: "正文", group: "Agent 学习" });
    const plain = ctx.store.create({ title: "散记", body: "正文" });
    ctx.indexer.indexFile(go.relPath);
    ctx.indexer.indexFile(agent.relPath);
    ctx.indexer.indexFile(plain.relPath);

    const tools = createTools({ db: ctx.db, store: ctx.store, notesRoot: ctx.notesRoot, readRoots: [ctx.notesRoot] });

    const inGroup = JSON.parse((await tools.run("list_notes", { group: "go 学习" })).content) as Array<{
      path: string;
    }>;
    assert.deepEqual(inGroup.map((item) => item.path), [go.relPath]);

    const none = JSON.parse((await tools.run("list_notes", { group: "none" })).content) as Array<{ path: string }>;
    assert.deepEqual(none.map((item) => item.path), [plain.relPath]);
  } finally {
    ctx.cleanup();
  }
});

test("read_note 的返回里带当前组", async () => {
  const ctx = makeCtx();
  try {
    const note = ctx.store.create({ title: "带组的", body: "正文", group: "Go 学习" });
    ctx.indexer.indexFile(note.relPath);
    const tools = createTools({ db: ctx.db, store: ctx.store, notesRoot: ctx.notesRoot, readRoots: [ctx.notesRoot] });

    const payload = JSON.parse((await tools.run("read_note", { path: note.relPath })).content) as { group: string | null };
    assert.equal(payload.group, "Go 学习");
  } finally {
    ctx.cleanup();
  }
});


test("list_notes 的 group=none 不区分大小写", async () => {
  const ctx = makeCtx();
  try {
    const grouped = ctx.store.create({ title: "有组", body: "正文", group: "Go 学习" });
    const loose = ctx.store.create({ title: "没组", body: "正文" });
    ctx.indexer.indexFile(grouped.relPath);
    ctx.indexer.indexFile(loose.relPath);
    const tools = createTools({ db: ctx.db, store: ctx.store, notesRoot: ctx.notesRoot, readRoots: [ctx.notesRoot] });

    const upper = JSON.parse((await tools.run("list_notes", { group: "NONE" })).content) as Array<{ path: string }>;
    assert.deepEqual(upper.map((item) => item.path), [loose.relPath]);
  } finally {
    ctx.cleanup();
  }
});
