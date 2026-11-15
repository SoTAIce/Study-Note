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

test("改过、删过笔记后片段仍取自各自的正文（perf-003：正文按 FTS rowid 取）", () => {
  const { store, db, indexer } = mk();
  const a = store.create({ title: "甲篇", body: "甲篇正文提到梯度下降。", tags: [] });
  const b = store.create({ title: "乙篇", body: "乙篇正文也提到梯度下降。", tags: [] });
  const c = store.create({ title: "丙篇", body: "丙篇正文同样梯度下降。", tags: [] });
  indexer.reindexAll();
  // 改甲、删丙：FTS 里的行会删了重插，rowid 变了
  const cur = store.read(a.relPath);
  store.save(a.relPath, "甲篇改过的正文，还是梯度下降。", cur.hash);
  indexer.indexFile(a.relPath);
  store.moveToTrash(c.relPath);
  indexer.removeFile(c.relPath);

  const hits = search(db, "梯度下降");
  assert.deepEqual(hits.map((h) => h.title).sort(), ["乙篇", "甲篇"]);
  for (const hit of hits) {
    const own = hit.title === "甲篇" ? "甲篇改过的正文" : "乙篇正文";
    assert.ok(hit.snippet.includes(own), `${hit.title} 的片段应来自自己的正文：${hit.snippet}`);
  }
  void b;
  db.close();
});

test("两个字的查询也能按标签筛选；同分按更新时间新的在前（perf-003 后行为不变）", () => {
  const { store, db, indexer } = mk();
  store.create({ title: "旧的", body: "讲矩阵的旧笔记", tags: ["数学"] });
  store.create({ title: "新的", body: "讲矩阵的新笔记", tags: ["数学"] });
  store.create({ title: "别的", body: "也讲矩阵", tags: ["杂项"] });
  indexer.reindexAll();
  const now = new Date(2030, 0, 1); // 都不算最近，只按时间排
  assert.deepEqual(search(db, "矩阵", { tag: "数学", now }).map((h) => h.title), ["新的", "旧的"]);
  assert.deepEqual(search(db, "矩阵", { tag: "没有的标签", now }), []);
  db.close();
});

test("标签命中排在只有正文命中之前；多个标签都能参与打分", () => {
  const { store, db, indexer } = mk();
  store.create({ title: "笔记一", body: "提到复习方法", tags: [] });
  store.create({ title: "笔记二", body: "提到复习方法", tags: ["随笔", "复习方法论"] });
  indexer.reindexAll();
  const hits = search(db, "复习方法", { now: new Date(2030, 0, 1) });
  assert.equal(hits[0].title, "笔记二");
  assert.equal(hits[0].score, 2);
  assert.equal(hits[1].score, 1);
  db.close();
});
