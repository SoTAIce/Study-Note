import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isSafeNotePath, normalizePlan, PlanError } from "../agent-plan.ts";
import { NoteStore } from "../store.ts";

function makeStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "study-plan-"));
  const notesRoot = path.join(dataDir, "notes");
  fs.mkdirSync(notesRoot, { recursive: true });
  const store = new NoteStore({
    notesRoot,
    historyDir: path.join(dataDir, ".history"),
    trashDir: path.join(dataDir, ".trash"),
  });
  return { store, notesRoot, dataDir, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return "NO_ERROR";
  } catch (err) {
    return (err as PlanError).code ?? "UNKNOWN";
  }
}

test("create 的合法路径原样保留", () => {
  const ctx = makeStore();
  try {
    const plan = normalizePlan(
      { summary: "新建一篇", ops: [{ kind: "create", path: "backend-go/08-测试.md", title: "测试", body: "# 测试" }] },
      { store: ctx.store, notesRoot: ctx.notesRoot },
    );
    assert.equal(plan.ops[0].path, "backend-go/08-测试.md");
    assert.equal(plan.ops[0].after, "# 测试");
    assert.equal(plan.ops[0].before.exists, false);
  } finally {
    ctx.cleanup();
  }
});

test("create 撞已有文件报 CONFLICT", () => {
  const ctx = makeStore();
  try {
    const existing = ctx.store.create({ title: "占位", body: "# x" });
    assert.equal(
      codeOf(() =>
        normalizePlan(
          { summary: "s", ops: [{ kind: "create", path: existing.relPath, title: "重复", body: "# y" }] },
          { store: ctx.store, notesRoot: ctx.notesRoot },
        ),
      ),
      "CONFLICT",
    );
  } finally {
    ctx.cleanup();
  }
});

test("没有 path 的 create 自动落 日期-slug.md", () => {
  const ctx = makeStore();
  try {
    const plan = normalizePlan(
      { summary: "s", ops: [{ kind: "create", title: "错误处理", body: "# 错误处理" }] },
      { store: ctx.store, notesRoot: ctx.notesRoot, now: () => new Date("2026-11-01T10:00:00") },
    );
    assert.match(plan.ops[0].path, /^\d{4}-\d{2}-\d{2}-.+\.md$/);
    assert.ok(plan.ops[0].path.includes("错误处理"));
  } finally {
    ctx.cleanup();
  }
});

test("rewrite 不存在的文件报 MISSING_FILE", () => {
  const ctx = makeStore();
  try {
    assert.equal(
      codeOf(() =>
        normalizePlan(
          { summary: "s", ops: [{ kind: "rewrite", path: "没有这篇.md", body: "# x" }] },
          { store: ctx.store, notesRoot: ctx.notesRoot },
        ),
      ),
      "MISSING_FILE",
    );
  } finally {
    ctx.cleanup();
  }
});

test("空操作被剔除，全是空操作则报 BAD_OP", () => {
  const ctx = makeStore();
  try {
    const note = ctx.store.create({ title: "原文", body: "正文" });
    // append 空文本 + rewrite 与原文相同 → 都被剔除
    assert.equal(
      codeOf(() =>
        normalizePlan(
          {
            summary: "s",
            ops: [
              { kind: "append", path: note.relPath, text: "   " },
              { kind: "rewrite", path: note.relPath, body: note.parsed.body },
            ],
          },
          { store: ctx.store, notesRoot: ctx.notesRoot },
        ),
      ),
      "BAD_OP",
    );
  } finally {
    ctx.cleanup();
  }
});

test("超过 20 条报 TOO_MANY", () => {
  const ctx = makeStore();
  try {
    const ops = Array.from({ length: 21 }, (_, i) => ({ kind: "create", title: `第${i}篇`, body: `# ${i}` }));
    assert.equal(
      codeOf(() => normalizePlan({ summary: "s", ops }, { store: ctx.store, notesRoot: ctx.notesRoot })),
      "TOO_MANY",
    );
  } finally {
    ctx.cleanup();
  }
});

test("trash 保留并带原文快照", () => {
  const ctx = makeStore();
  try {
    const note = ctx.store.create({ title: "要清掉的", body: "旧内容" });
    const plan = normalizePlan(
      { summary: "清理", ops: [{ kind: "trash", path: note.relPath }] },
      { store: ctx.store, notesRoot: ctx.notesRoot },
    );
    assert.equal(plan.ops[0].kind, "trash");
    assert.equal(plan.ops[0].before.exists, true);
    assert.ok(plan.ops[0].before.raw.includes("旧内容"));
    assert.equal(plan.ops[0].after, "");
  } finally {
    ctx.cleanup();
  }
});

test("diff 统计正确", () => {
  const ctx = makeStore();
  try {
    const note = ctx.store.create({ title: "三行", body: "a\nb\nc" });
    const plan = normalizePlan(
      { summary: "s", ops: [{ kind: "rewrite", path: note.relPath, body: "a\nx\nc\nd" }] },
      { store: ctx.store, notesRoot: ctx.notesRoot },
    );
    assert.equal(plan.ops[0].add, 2);
    assert.equal(plan.ops[0].del, 1);
  } finally {
    ctx.cleanup();
  }
});

test("Windows 保留名与越界路径被拒", () => {
  assert.equal(isSafeNotePath("CON.md"), false);
  assert.equal(isSafeNotePath("../a.md"), false);
  assert.equal(isSafeNotePath("C:\\a.md"), false);
  assert.equal(isSafeNotePath(".hidden/a.md"), false);
  assert.equal(isSafeNotePath("a.txt"), false);
  assert.equal(isSafeNotePath("中文 目录/a.md"), true);
  const ctx = makeStore();
  try {
    assert.equal(
      codeOf(() =>
        normalizePlan(
          { summary: "s", ops: [{ kind: "create", path: "CON.md", title: "x", body: "# x" }] },
          { store: ctx.store, notesRoot: ctx.notesRoot },
        ),
      ),
      "BAD_PATH",
    );
  } finally {
    ctx.cleanup();
  }
});

test("含 # % 空格 的中文文件名原样保留", () => {
  const ctx = makeStore();
  try {
    const plan = normalizePlan(
      { summary: "s", ops: [{ kind: "create", path: "a#b 50% 测试.md", title: "带符号", body: "# 带符号" }] },
      { store: ctx.store, notesRoot: ctx.notesRoot },
    );
    assert.equal(plan.ops[0].path, "a#b 50% 测试.md");
  } finally {
    ctx.cleanup();
  }
});

test("路径里带冒号等 Windows 非法字符会被拒（ADS 逃逸）", () => {
  assert.equal(isSafeNotePath("notes/a:b.md"), false);
  assert.equal(isSafeNotePath("ab:c.md"), false);
  assert.equal(isSafeNotePath("a*b.md"), false);
  assert.equal(isSafeNotePath("a?b.md"), false);
  assert.equal(isSafeNotePath("a|b.md"), false);
  // 正常的中文、空格、# 仍然要放行
  assert.equal(isSafeNotePath("backend-go/04-JSON 响应与 enevelope#1.md"), true);
});


// ---- 分组（plan op 的 group） ----

test("create 带 group 会被写进计划；非法组名判 BAD_OP", () => {
  const { store, cleanup } = makeStore();
  try {
    const plan = normalizePlan(
      { summary: "建一篇到 Go 学习", ops: [{ kind: "create", title: "接口", body: "正文", group: "Go 学习" }] },
      { store, notesRoot: store.notesRoot },
    );
    assert.equal(plan.ops[0].group, "Go 学习");

    assert.equal(
      codeOf(() =>
        normalizePlan(
          { summary: "非法组", ops: [{ kind: "create", title: "接口", body: "正文", group: "Go/学习" }] },
          { store, notesRoot: store.notesRoot },
        ),
      ),
      "BAD_OP",
    );
  } finally {
    cleanup();
  }
});

test("append / rewrite 的 group 也保留在计划里", () => {
  const { store, cleanup } = makeStore();
  try {
    const note = store.create({ title: "已有", body: "原文" });
    const plan = normalizePlan(
      {
        summary: "改",
        ops: [
          { kind: "append", path: note.relPath, text: "补一句", group: "Go 学习" },
          { kind: "rewrite", path: note.relPath, body: "重写后的正文", group: "Agent 学习" },
        ],
      },
      { store, notesRoot: store.notesRoot },
    );
    assert.equal(plan.ops[0].group, "Go 学习");
    assert.equal(plan.ops[1].group, "Agent 学习");
  } finally {
    cleanup();
  }
});
