import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../db.ts";
import { Indexer } from "../indexer.ts";
import { NoteStore } from "../store.ts";
import { search } from "../search.ts";

function mk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sn-search-"));
  const notesRoot = path.join(root, "notes");
  let t = new Date(2026, 9, 30, 10, 0, 0).getTime();
  const store = new NoteStore({
    notesRoot,
    historyDir: path.join(root, "history"),
    trashDir: path.join(root, "trash"),
    now: () => new Date((t += 86400000)),
  });
  const db = openDb(path.join(root, "index.db"));
  const indexer = new Indexer({ db, store });
  return { root, store, db, indexer };
}

function seed(store: NoteStore, indexer: Indexer) {
  store.create({
    title: "向量数据库的索引结构",
    body: "HNSW 是一种近似最近邻索引，靠图结构做向量检索。",
    tags: ["深度学习"],
  });
  store.create({
    title: "位置编码",
    body: "Transformer 用位置编码注入顺序信息，这里也会提到 transformer 的变体，顺带讨论了索引的问题。",
    tags: ["论文"],
  });
  store.create({ title: "随手记", body: "今天看了点东西，没写关键词。", tags: [] });
  indexer.reindexAll();
}

test("2 个汉字的查询也能命中（LIKE 兜底路径）", () => {
  const { store, db, indexer } = mk();
  seed(store, indexer);
  for (const q of ["向量", "数据", "索引", "位置", "编码"]) {
    const hits = search(db, q);
    assert.ok(hits.length > 0, `查询「${q}」应该有结果`);
  }
  db.close();
});

test("3 字以上走 FTS 且中英文都能命中", () => {
  const { store, db, indexer } = mk();
  seed(store, indexer);
  assert.ok(search(db, "向量数据库").length > 0);
  assert.ok(search(db, "最近邻").length > 0);
  assert.ok(search(db, "transformer").length > 0);
  assert.equal(search(db, "transformer").length, search(db, "Transformer").length);
  db.close();
});

test("查不到时返回空数组而不是报错", () => {
  const { store, db, indexer } = mk();
  seed(store, indexer);
  assert.deepEqual(search(db, "zzzz不存在的东西"), []);
  assert.deepEqual(search(db, "  "), []);
  db.close();
});

test("标题命中排在只有正文命中的笔记之前", () => {
  const { store, db, indexer } = mk();
  seed(store, indexer);
  const hits = search(db, "索引");
  assert.ok(hits.length >= 2);
  assert.equal(hits[0].title, "向量数据库的索引结构");
  db.close();
});

test("标签筛选只返回带该标签的笔记，片段带 <mark>", () => {
  const { store, db, indexer } = mk();
  seed(store, indexer);
  const tagged = search(db, "向量", { tag: "深度学习" });
  assert.equal(tagged.length, 1);
  const other = search(db, "向量", { tag: "论文" });
  assert.equal(other.length, 0);

  const hits = search(db, "向量");
  assert.ok(hits[0].snippet.includes("<mark>向量</mark>"), hits[0].snippet);
  db.close();
});

test("limit 生效，结果带 id 与相对路径", () => {
  const { store, db, indexer } = mk();
  seed(store, indexer);
  const hits = search(db, "的", { limit: 1 });
  assert.equal(hits.length, 1);
  assert.ok(hits[0].id.length > 0);
  assert.ok(hits[0].relPath.endsWith(".md"));
  db.close();
});
