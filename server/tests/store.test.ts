import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NoteStore, ConflictError } from "../store.ts";

function mkStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sn-store-"));
  let t = new Date(2026, 9, 30, 10, 0, 0).getTime();
  const store = new NoteStore({
    notesRoot: path.join(root, "notes"),
    historyDir: path.join(root, "history"),
    trashDir: path.join(root, "trash"),
    now: () => new Date((t += 1000)),
  });
  return { store, root };
}

test("create 生成规范文件名与 frontmatter", () => {  const { store } = mkStore();
  const n = store.create({
    title: "Transformer 的位置编码",
    body: "正文 [[注意力]] #深度学习",
    tags: ["深度学习"],
  });
  assert.match(n.relPath, /^\d{4}-\d{2}-\d{2}-.+\.md$/);
  assert.equal(path.basename(n.relPath), "2026-10-30-Transformer-的位置编码.md");
  assert.match(n.raw, /^---\n/);
  assert.equal(n.parsed.meta.type, "note");
  assert.deepEqual(n.parsed.meta.tags, ["深度学习"]);
  assert.ok(n.id.length >= 6);
  assert.equal(n.parsed.body, "正文 [[注意力]] #深度学习");
});

test("idea 落在 inbox/ 下并用正文前若干字当 slug", () => {
  const { store } = mkStore();
  const idea = store.create({ body: "突然想到：稀疏注意力可能更省显存", type: "idea" });
  assert.ok(idea.relPath.startsWith("inbox/"));
  assert.equal(idea.parsed.meta.type, "idea");
  assert.ok(path.basename(idea.relPath).includes("突然想到"));
});

test("同一天同标题再次创建不会覆盖，文件名加序号", () => {
  const { store } = mkStore();
  const a = store.create({ title: "重名", body: "一" });
  const b = store.create({ title: "重名", body: "二" });
  assert.notEqual(a.relPath, b.relPath);
  assert.match(b.relPath, /-2\.md$/);
  assert.equal(store.read(a.relPath).parsed.body, "一");
});

test("save 会把旧版本留在 history 里", () => {
  const { store } = mkStore();
  const n = store.create({ title: "历史", body: "第一版" });
  const saved = store.save(n.relPath, "第二版", n.hash);
  const dir = path.join(store.historyDir, n.id);
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.ok(fs.readFileSync(path.join(dir, files[0]), "utf8").includes("第一版"));
  assert.equal(saved.parsed.body, "第二版");
  assert.notEqual(saved.hash, n.hash);
});

test("连续自动保存 25 次只在开头存一份历史（10 分钟内合并）", () => {
  const { store } = mkStore();
  let n = store.create({ title: "合并", body: "v0" });
  for (let i = 1; i <= 25; i++) n = store.save(n.relPath, `v${i}`, n.hash);
  const files = fs.readdirSync(path.join(store.historyDir, n.id));
  assert.equal(files.length, 1);
  assert.ok(fs.readFileSync(path.join(store.historyDir, n.id, files[0]), "utf8").includes("v0"));
  assert.ok(fs.readFileSync(path.join(store.notesRoot, n.relPath), "utf8").includes("v25"));
});

test("旧内容超过 2MB 时不再复制历史版本，但保存成功", () => {
  const { store } = mkStore();
  const n = store.create({ title: "大文件", body: "小" });
  const big = "x".repeat(2 * 1024 * 1024 + 10);
  const saved = store.save(n.relPath, big, n.hash);
  assert.ok(saved.parsed.body.length > 2 * 1024 * 1024);
  const dir = path.join(store.historyDir, n.id);
  assert.equal(fs.readdirSync(dir).length, 1);
  const again = store.save(saved.relPath, `${big}y`, saved.hash);
  assert.equal(fs.readdirSync(dir).length, 1);
  assert.ok(again.parsed.body.endsWith("y"));
});

test("baseHash 过期抛 ConflictError 且文件内容不变", () => {
  const { store } = mkStore();
  const n = store.create({ title: "冲突", body: "原来的内容" });
  assert.throws(
    () => store.save(n.relPath, "覆盖尝试", "0".repeat(64)),
    (err: unknown) => err instanceof ConflictError || (err as { code?: string }).code === "CONFLICT",
  );
  assert.equal(store.read(n.relPath).parsed.body, "原来的内容");
});

test("list 只列 .md、递归包含子目录、中文与空格文件名可读回", () => {
  const { store } = mkStore();
  const n = store.create({ title: "中文 空格 名字", body: "内容" });
  store.create({ body: "一条想法", type: "idea" });
  fs.writeFileSync(path.join(store.notesRoot, "notes.txt"), "不是笔记", "utf8");
  const list = store.list();
  assert.equal(list.length, 2);
  assert.ok(list.includes(n.relPath));
  assert.ok(list.some((p) => p.startsWith("inbox/")));
  assert.equal(store.read(n.relPath).parsed.body, "内容");
  assert.equal(store.read(n.relPath).parsed.meta.title, "中文 空格 名字");
});

test("moveToTrash / listTrash / restore 走完一圈", () => {
  const { store } = mkStore();
  const n = store.create({ title: "待删", body: "内容" });
  const { name } = store.moveToTrash(n.relPath);
  assert.equal(store.list().includes(n.relPath), false);
  const trashed = store.listTrash();
  assert.equal(trashed.length, 1);
  assert.equal(trashed[0].origPath, n.relPath);
  assert.ok(trashed[0].deletedAt.length > 0);
  const restored = store.restore(name);
  assert.equal(restored.relPath, n.relPath);
  assert.ok(fs.existsSync(path.join(store.notesRoot, n.relPath)));
  assert.equal(store.listTrash().length, 0);
});

test("restore 撞上同名文件时改名而不是覆盖", () => {
  const { store } = mkStore();
  const n = store.create({ title: "撞名", body: "内容" });
  const { name } = store.moveToTrash(n.relPath);
  fs.mkdirSync(path.dirname(path.join(store.notesRoot, n.relPath)), { recursive: true });
  fs.writeFileSync(path.join(store.notesRoot, n.relPath), "占位", "utf8");
  const restored = store.restore(name);
  assert.notEqual(restored.relPath, n.relPath);
  assert.match(restored.relPath, /-1\.md$/);
  assert.equal(fs.readFileSync(path.join(store.notesRoot, n.relPath), "utf8"), "占位");
});

test("无标题时从正文取标题：截断但不留省略号，文件名也不带", () => {
  const { store } = mkStore();
  const long = "这个想法有点长需要被截断成一个短标题因为它超过了二十个字的长度限制";
  const n = store.create({ body: long, type: "idea" });
  assert.equal(n.parsed.meta.title.includes("…"), false, `标题不该带省略号：${n.parsed.meta.title}`);
  assert.ok(n.parsed.meta.title.length <= 20, `标题应截断到 20 字，实际 ${n.parsed.meta.title.length}`);
  assert.equal(path.basename(n.relPath).includes("…"), false, `文件名不该带省略号：${n.relPath}`);
  assert.match(n.relPath, /^inbox\//);
});



// ---- 分组（setGroup） ----

test("setGroup 只改 group 一行：正文、updated 与其它 frontmatter 键都不变", () => {
  const { store } = mkStore();
  const created = store.create({ title: "Go 接口", body: "正文 [[双链]]", tags: ["go"] });
  const before = store.read(created.relPath);

  const moved = store.setGroup(created.relPath, "Go 学习", { baseHash: before.hash });

  assert.equal(moved.parsed.meta.group, "Go 学习");
  assert.equal(moved.parsed.body, before.parsed.body);
  assert.equal(moved.parsed.meta.updated, before.parsed.meta.updated);
  assert.equal(moved.parsed.meta.created, before.parsed.meta.created);
  assert.equal(moved.parsed.meta.title, before.parsed.meta.title);
  assert.deepEqual(moved.parsed.meta.tags, before.parsed.meta.tags);
  assert.equal(moved.relPath, created.relPath);
});

test("setGroup 给没有 frontmatter 的笔记插最小块，正文一字不动", () => {
  const { store, root } = mkStore();
  const rel = "backend-go/00-代码地图.md";
  const raw = "# 代码地图\n\n第一段\n";
  fs.mkdirSync(path.join(root, "notes", "backend-go"), { recursive: true });
  fs.writeFileSync(path.join(root, "notes", "backend-go", "00-代码地图.md"), raw, "utf8");

  const moved = store.setGroup(rel, "Go 学习");

  assert.equal(moved.raw, "---\ngroup: Go 学习\n---\n\n# 代码地图\n\n第一段\n");
  assert.equal(moved.parsed.body, raw);
  assert.equal(moved.parsed.meta.group, "Go 学习");
});

test("setGroup 不写历史快照，也不动 mtime 之外的 updated", () => {
  const { store, root } = mkStore();
  const created = store.create({ title: "笔记", body: "正文" });
  const before = store.read(created.relPath);
  store.setGroup(created.relPath, "Go 学习");

  const historyDir = path.join(root, "history", before.id);
  assert.equal(fs.existsSync(historyDir), false);
});

test("setGroup 的 baseHash 不符时抛 ConflictError", () => {
  const { store } = mkStore();
  const created = store.create({ title: "笔记", body: "正文" });
  assert.throws(() => store.setGroup(created.relPath, "Go 学习", { baseHash: "deadbeef" }), ConflictError);
});

test("setGroup 同组幂等：不写盘、hash 不变", () => {
  const { store } = mkStore();
  const created = store.create({ title: "笔记", body: "正文", group: "Go 学习" });
  const before = store.read(created.relPath);
  const again = store.setGroup(created.relPath, "go 学习");
  assert.equal(again.hash, before.hash);
});

test("setGroup 传 null 退回未分组", () => {
  const { store } = mkStore();
  const created = store.create({ title: "笔记", body: "正文", group: "Go 学习" });
  const cleared = store.setGroup(created.relPath, null);
  assert.equal(cleared.parsed.meta.group, undefined);
  assert.equal(cleared.raw.includes("group:"), false);
});

test("setGroup 拒绝非法组名，且不动文件", () => {
  const { store } = mkStore();
  const created = store.create({ title: "笔记", body: "正文" });
  const before = store.read(created.relPath);
  assert.throws(() => store.setGroup(created.relPath, "Go/学习"), /参数错误：/);
  assert.equal(store.read(created.relPath).hash, before.hash);
});

test("save() 之后 group 仍在（正文编辑不能洗掉组）", () => {
  const { store } = mkStore();
  const created = store.create({ title: "笔记", body: "正文", group: "Go 学习" });
  const current = store.read(created.relPath);
  const saved = store.save(created.relPath, "改过的正文", current.hash, { tags: ["go"] });
  assert.equal(saved.parsed.meta.group, "Go 学习");
  assert.equal(saved.parsed.body, "改过的正文");
});

test("create 与 createAt 都能直接指定 group", () => {
  const { store } = mkStore();
  const created = store.create({ title: "笔记", body: "正文", group: "Agent 学习" });
  assert.equal(created.parsed.meta.group, "Agent 学习");

  const at = store.createAt("backend-go/09-新笔记.md", { title: "新", body: "正文", group: "Go 学习" });
  assert.equal(at.parsed.meta.group, "Go 学习");
});

test("store.setGroup 对没有 frontmatter 的笔记来回移动后正文与 updated 都不变", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "study-parse-group-"));
  try {
    const notesRoot = path.join(dataDir, "notes");
    fs.mkdirSync(path.join(notesRoot, "go"), { recursive: true });
    const file = path.join(notesRoot, "go", "旧笔记.md");
    const raw = "# 旧标题\n\n第一行\n第二行\n";
    fs.writeFileSync(file, raw, "utf8");

    const store = new NoteStore({
      notesRoot,
      historyDir: path.join(dataDir, ".history"),
      trashDir: path.join(dataDir, ".trash"),
    });
    const before = store.read("go/旧笔记.md");
    store.setGroup("go/旧笔记.md", "Go 学习");
    const grouped = store.read("go/旧笔记.md");
    assert.equal(grouped.parsed.meta.group, "Go 学习");
    assert.equal(grouped.parsed.meta.updated, before.parsed.meta.updated, "归组不能改 updated");

    store.setGroup("go/旧笔记.md", null);
    assert.equal(fs.readFileSync(file, "utf8"), raw, "移出分组后文件应逐字节还原");
    assert.equal(fs.existsSync(path.join(dataDir, ".history")), false, "整理动作不写历史快照");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
 

test("setGroup 保留文件 mtime：没有 updated: 的笔记不会因为归组跳到「刚编辑」", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-store-mtime-"));
  try {
    const notesRoot = path.join(dataDir, "notes");
    fs.mkdirSync(notesRoot, { recursive: true });
    const abs = path.join(notesRoot, "旧笔记.md");
    fs.writeFileSync(abs, "# 旧笔记\n\n正文\n", "utf8");
    const old = new Date("2026-10-01T00:00:00Z");
    fs.utimesSync(abs, old, old);

    const store = new NoteStore({
      notesRoot,
      historyDir: path.join(dataDir, "history"),
      trashDir: path.join(dataDir, "trash"),
    });
    const before = store.read("旧笔记.md");
    store.setGroup("旧笔记.md", "Go 学习");
    const after = store.read("旧笔记.md");

    assert.equal(after.parsed.meta.group, "Go 学习");
    assert.equal(after.parsed.meta.updated, before.parsed.meta.updated, "updated 不该变");
    assert.equal(after.parsed.meta.created, before.parsed.meta.created, "created 不该变");
    assert.equal(fs.statSync(abs).mtimeMs, old.getTime(), "mtime 要被还原");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
