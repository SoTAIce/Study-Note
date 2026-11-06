import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, SCHEMA_VERSION } from "../db.ts";
import { Indexer } from "../indexer.ts";
import { NoteStore } from "../store.ts";

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sn-idx-"));
  const notesRoot = path.join(root, "notes");
  const store = new NoteStore({
    notesRoot,
    historyDir: path.join(root, "history"),
    trashDir: path.join(root, "trash"),
    now: () => new Date("2026-10-30T02:00:00Z"),
  });
  const db = openDb(path.join(root, "index.db"));
  const indexer = new Indexer({ db, store });
  return { root, notesRoot, store, db, indexer };
}

test("openDb 幂等、WAL 开启、schema 版本写入", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sn-db-"));
  const file = path.join(root, "index.db");
  const a = openDb(file);
  const version = a.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
  assert.equal(version.value, String(SCHEMA_VERSION));
  const mode = a.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
  assert.equal(mode.journal_mode.toLowerCase(), "wal");
  a.close();
  const b = openDb(file);
  assert.ok(b.prepare("SELECT 1 AS ok").get());
  b.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("reindexAll 索引三张表：无 frontmatter、子目录、中文文件名", () => {
  const { notesRoot, store, db, indexer } = mk();
  fs.writeFileSync(path.join(notesRoot, "裸笔记.md"), "没有 frontmatter 的正文 #随手", "utf8");
  fs.mkdirSync(path.join(notesRoot, "inbox"), { recursive: true });
  fs.writeFileSync(
    path.join(notesRoot, "inbox", "2026-10-30-想法.md"),
    "---\nid: idea0001\ntitle: 想法\ntype: idea\ntags: [灵感]\n---\n想到 [[裸笔记]]",
    "utf8",
  );
  store.create({ title: "深度学习笔记", body: "反向传播 #深度学习 见 [[想法]]", tags: ["深度学习"] });

  const result = indexer.reindexAll();
  assert.equal(result.indexed, 3);
  assert.equal(result.removed, 0);

  const notes = db.prepare("SELECT id, title, type FROM notes ORDER BY path").all() as Array<{
    id: string;
    title: string;
    type: string;
  }>;
  assert.equal(notes.length, 3);
  assert.ok(notes.some((n) => n.title === "裸笔记" && n.type === "note"));
  assert.ok(notes.some((n) => n.title === "想法" && n.type === "idea"));

  const tags = db.prepare("SELECT tag FROM tags").all() as Array<{ tag: string }>;
  const tagSet = new Set(tags.map((t) => t.tag));
  assert.ok(tagSet.has("深度学习"));
  assert.ok(tagSet.has("随手"));
  assert.ok(tagSet.has("灵感"));

  const links = db.prepare("SELECT src_id, target_title, target_id FROM links").all() as Array<{
    src_id: string;
    target_title: string;
    target_id: string | null;
  }>;
  assert.equal(links.length, 2);
  const toBare = links.find((l) => l.target_title === "裸笔记");
  assert.ok(toBare);
  assert.ok(toBare.target_id, "同名目标应解析出 target_id");
  db.close();
});

test("同名笔记时 target_id 解析到排序第一的那条且不抛错", () => {
  const { notesRoot, db, indexer } = mk();
  fs.mkdirSync(path.join(notesRoot, "a"), { recursive: true });
  fs.mkdirSync(path.join(notesRoot, "b"), { recursive: true });
  fs.writeFileSync(path.join(notesRoot, "a", "同名.md"), "---\ntitle: 同名\nid: aaaa1111\n---\nA 的内容", "utf8");
  fs.writeFileSync(path.join(notesRoot, "b", "同名.md"), "---\ntitle: 同名\nid: bbbb2222\n---\nB 的内容", "utf8");
  fs.writeFileSync(path.join(notesRoot, "引用者.md"), "---\ntitle: 引用者\nid: cccc3333\n---\n见 [[同名]]", "utf8");
  assert.doesNotThrow(() => indexer.reindexAll());
  const link = db.prepare("SELECT target_id FROM links WHERE target_title = '同名'").get() as {
    target_id: string | null;
  };
  assert.equal(link.target_id, "aaaa1111");
  db.close();
});

test("indexFile 更新 content_hash；removeFile 清干净；空目录 reindexAll 返回 0", () => {
  const { notesRoot, store, db, indexer } = mk();
  const note = store.create({ title: "会变的", body: "第一版" });
  indexer.reindexAll();
  const before = db.prepare("SELECT content_hash FROM notes WHERE path = ?").get(note.relPath) as {
    content_hash: string;
  };
  store.save(note.relPath, "第二版", note.hash);
  indexer.indexFile(note.relPath);
  const after = db.prepare("SELECT content_hash FROM notes WHERE path = ?").get(note.relPath) as {
    content_hash: string;
  };
  assert.notEqual(before.content_hash, after.content_hash);

  const second = store.create({ title: "会被删的", body: "内容" });
  indexer.indexFile(second.relPath);
  fs.rmSync(path.join(notesRoot, second.relPath));
  indexer.removeFile(second.relPath);
  for (const table of ["notes", "tags", "links", "notes_fts"]) {
    const col =
      table === "notes" ? "path" : table === "links" ? "src_id" : "note_id";
    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`)
      .get(table === "notes" ? second.relPath : second.id) as { n: number };
    assert.equal(rows.n, 0, `${table} 里应该没有残留`);
  }

  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sn-empty-"));
  const emptyStore = new NoteStore({
    notesRoot: path.join(emptyRoot, "notes"),
    historyDir: path.join(emptyRoot, "h"),
    trashDir: path.join(emptyRoot, "t"),
  });
  const emptyIndexer = new Indexer({ db: openDb(path.join(emptyRoot, "index.db")), store: emptyStore });
  assert.deepEqual(emptyIndexer.reindexAll(), { indexed: 0, removed: 0, failed: 0 });
  db.close();
});

test("两个文件共用同一个 frontmatter id 时，两条都留在索引里（复制 .md 的常见情形）", () => {
  const { notesRoot, db, indexer } = mk();
  fs.writeFileSync(path.join(notesRoot, "原件.md"), "---\ntitle: 原件\nid: same9999\n---\n原件内容", "utf8");
  fs.writeFileSync(path.join(notesRoot, "副本.md"), "---\ntitle: 副本\nid: same9999\n---\n副本内容", "utf8");

  const result = indexer.reindexAll();
  assert.equal(result.indexed, 2);
  assert.equal(result.failed, 0);

  const rows = db.prepare("SELECT id, path, title FROM notes ORDER BY path").all() as Array<{
    id: string;
    path: string;
    title: string;
  }>;
  assert.equal(rows.length, 2, `两条笔记都该在索引里，实际 ${rows.length}`);
  assert.equal(new Set(rows.map((r) => r.id)).size, 2, "id 不能撞");
  const ids = rows.map((r) => r.id).sort();
  assert.equal(ids.filter((id) => id === "same9999").length, 1, "只有一条能保留原 id");
  assert.equal(
    ids.filter((id) => id.startsWith("same9999-")).length,
    1,
    `另一条应换用从路径派生的 id，实际 ${ids.join(",")}`,
  );
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM notes_fts").get() as { n: number }).n,
    2,
    "两条都要能搜到",
  );
  db.close();
});

test("单个文件读不出来时跳过它，其余照常索引，并在结果里记 failed", () => {
  const { notesRoot, store, db, indexer } = mk();
  fs.writeFileSync(path.join(notesRoot, "好的.md"), "---\ntitle: 好的\n---\n正常内容", "utf8");
  fs.writeFileSync(path.join(notesRoot, "坏的.md"), "---\ntitle: 坏的\n---\n本来也正常", "utf8");

  const originalRead = store.read.bind(store);
  (store as unknown as { read: (rel: string) => unknown }).read = (rel: string) => {
    if (rel.endsWith("坏的.md")) throw new Error("模拟读取失败（比如文件被独占锁住）");
    return originalRead(rel);
  };

  const result = indexer.reindexAll();
  assert.equal(result.failed, 1);
  assert.equal(result.indexed, 1);
  const row = db.prepare("SELECT title FROM notes").all() as Array<{ title: string }>;
  assert.equal(row.length, 1);
  assert.equal(row[0].title, "好的");
  db.close();
});

test("watch 会增量索引新文件，取消后不再索引", async () => {
  const { notesRoot, db, indexer } = mk();
  const stop = indexer.watch();
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  fs.writeFileSync(path.join(notesRoot, "2026-10-30-watch测试.md"), "---\ntitle: watch测试\n---\n内容", "utf8");
  await wait(900);
  const hit = db.prepare("SELECT title FROM notes WHERE title = 'watch测试'").get();
  assert.ok(hit, "watch 应该把新文件索引进来");

  stop();
  fs.writeFileSync(path.join(notesRoot, "2026-10-30-取消后.md"), "---\ntitle: 取消后\n---\n内容", "utf8");
  await wait(900);
  const miss = db.prepare("SELECT title FROM notes WHERE title = '取消后'").get();
  assert.equal(miss, undefined);
  db.close();
});


// ---- 分组的索引列 ----

test("索引表有 group_name 列，且把笔记的组写进去", () => {
  const { store, db, indexer } = mk();
  const grouped = store.create({ title: "Go 接口", body: "正文", group: "Go 学习" });
  const plain = store.create({ title: "散记", body: "正文" });
  indexer.indexFile(grouped.relPath);
  indexer.indexFile(plain.relPath);

  const rows = db.prepare("SELECT path, group_name FROM notes ORDER BY path").all() as Array<{
    path: string;
    group_name: string | null;
  }>;
  const byPath = new Map(rows.map((row) => [row.path, row.group_name]));
  assert.equal(byPath.get(grouped.relPath), "Go 学习");
  assert.equal(byPath.get(plain.relPath), null);
});

test("改组之后重新索引，group_name 跟着变；SCHEMA_VERSION 升到 2", () => {
  const { store, db, indexer } = mk();
  assert.equal(SCHEMA_VERSION, 2);

  const note = store.create({ title: "Go 接口", body: "正文" });
  indexer.indexFile(note.relPath);
  store.setGroup(note.relPath, "Go 学习");
  indexer.indexFile(note.relPath);

  const row = db.prepare("SELECT group_name FROM notes WHERE path = ?").get(note.relPath) as {
    group_name: string | null;
  };
  assert.equal(row.group_name, "Go 学习");
});

test("旧版本库（schema_version=1）打开后整库重建并带上 group_name 列", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sn-db-old-"));
  const file = path.join(root, "index.db");
  const first = openDb(file);
  first.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
  first.close();

  const second = openDb(file);
  const cols = second.prepare("PRAGMA table_info(notes)").all() as Array<{ name: string }>;
  assert.ok(cols.some((col) => col.name === "group_name"), JSON.stringify(cols));
  const version = second.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
  assert.equal(version.value, "2");
  second.close();
});
