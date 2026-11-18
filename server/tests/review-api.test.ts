import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../app.ts";
import { createApi } from "../api.ts";
import { openDb } from "../db.ts";
import { Indexer } from "../indexer.ts";
import { ReviewLog } from "../review.ts";
import { NoteStore } from "../store.ts";

let tmp: string;
let server: http.Server;
let base: string;
let store: NoteStore;
let db: ReturnType<typeof openDb>;
let indexer: Indexer;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sn-review-api-"));
  const notesRoot = path.join(tmp, "notes");
  store = new NoteStore({ notesRoot, historyDir: path.join(tmp, "history"), trashDir: path.join(tmp, "trash") });
  db = openDb(path.join(tmp, "index.db"));
  indexer = new Indexer({ db, store });
  const api = createApi({ store, indexer, db, dataDir: tmp, review: new ReviewLog({ dataDir: tmp }) });
  const app = createApp({ dataDir: tmp, notesRoot, distDir: path.join(tmp, "dist"), api });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const ml = store.create({
    title: "机器学习",
    body: "> [!card] 梯度下降\n> - 沿负梯度更新\n\n过拟合 :: 学进了噪声\n",
    tags: ["期末"],
    group: "AI",
  });
  const prob = store.create({ title: "概率论", body: "贝叶斯 :: P(A|B) = P(B|A)P(A)/P(B)\n", tags: [], group: "数学" });
  indexer.indexFile(ml.relPath);
  indexer.indexFile(prob.relPath);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function call(method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test("卡片墙：列出全部简卡，带来源笔记和熟练度；按分组 / 标签 / 关键字筛选", async () => {
  const all = await call("GET", "/api/cards");
  assert.equal(all.status, 200);
  assert.deepEqual(all.json.items.map((c: any) => c.title).sort(), ["梯度下降", "贝叶斯", "过拟合"].sort());
  const gd = all.json.items.find((c: any) => c.title === "梯度下降");
  assert.equal(gd.noteTitle, "机器学习");
  assert.equal(gd.group, "AI");
  assert.equal(gd.kind, "callout");
  assert.equal(gd.body, "- 沿负梯度更新");
  assert.equal(gd.mastery, "new");
  assert.equal(all.json.total, 3);

  assert.deepEqual((await call("GET", "/api/cards?group=数学")).json.items.map((c: any) => c.title), ["贝叶斯"]);
  assert.equal((await call("GET", "/api/cards?tag=期末")).json.items.length, 2);
  assert.deepEqual((await call("GET", "/api/cards?q=噪声")).json.items.map((c: any) => c.title), ["过拟合"]);
});

test("卡片墙按父分组筛选时包含子项目里的简卡", async () => {
  const sub = store.create({ title: "子项目笔记", body: "looprun :: 主循环\n", tags: [], group: "数学/统计" });
  indexer.indexFile(sub.relPath);
  try {
    const parent = (await call("GET", "/api/cards?group=数学")).json.items.map((c: any) => c.title).sort();
    assert.deepEqual(parent, ["looprun", "贝叶斯"].sort());
    const child = (await call("GET", "/api/cards?group=数学/统计")).json.items.map((c: any) => c.title);
    assert.deepEqual(child, ["looprun"]);
  } finally {
    store.moveToTrash(sub.relPath);
    indexer.removeFile(sub.relPath);
  }
});

test("今日复习：队列带四档的到期时间；打分后熟练度变化、队列变短；撤回恢复", async () => {
  const queue = await call("GET", "/api/review/queue?group=AI");
  assert.equal(queue.status, 200);
  assert.equal(queue.json.items.length, 2);
  assert.equal(queue.json.fresh, 2);
  const card = queue.json.items[0];
  assert.ok(card.next["1"] < card.next["3"] && card.next["3"] < card.next["4"]);

  const graded = await call("POST", "/api/review/grade", { card: card.id, grade: 3 });
  assert.equal(graded.status, 200);
  assert.equal(graded.json.mastery, "learning");
  assert.ok(graded.json.due > Date.now() + 86_400_000);

  const after = await call("GET", "/api/review/queue?group=AI");
  assert.deepEqual(after.json.items.map((c: any) => c.id), [queue.json.items[1].id]);
  const summary = await call("GET", "/api/review/summary");
  assert.equal(summary.json.fresh, 2);

  assert.equal((await call("POST", "/api/review/undo", { card: card.id })).json.ok, true);
  assert.equal((await call("GET", "/api/review/queue?group=AI")).json.items.length, 2);
  assert.ok(fs.readFileSync(path.join(tmp, "review", "log.jsonl"), "utf8").includes('"undo"'));
});

test("打分参数检查：档位不对 400，卡不存在 404", async () => {
  const cards = (await call("GET", "/api/cards")).json.items;
  assert.equal((await call("POST", "/api/review/grade", { card: cards[0].id, grade: 5 })).status, 400);
  assert.equal((await call("POST", "/api/review/grade", { card: "c_nope", grade: 3 })).status, 404);
});

test("每天新卡上限：可设置，范围外 400；设成 1 后队列里只有 1 张新卡", async () => {
  assert.equal((await call("GET", "/api/review/settings")).json.newPerDay, 20);
  assert.equal((await call("PUT", "/api/review/settings", { newPerDay: 999 })).status, 400);
  assert.equal((await call("PUT", "/api/review/settings", { newPerDay: 1 })).json.newPerDay, 1);
  assert.equal((await call("GET", "/api/review/queue")).json.items.length, 1);
  await call("PUT", "/api/review/settings", { newPerDay: 20 });
});

test("改了卡片标题：复习记录跟着走（日志里记别名）", async () => {
  const before = (await call("GET", "/api/cards?q=贝叶斯")).json.items[0];
  await call("POST", "/api/review/grade", { card: before.id, grade: 3 });
  const note = store.read(before.notePath);
  store.save(before.notePath, "贝叶斯公式 :: P(A|B) = P(B|A)P(A)/P(B)\n", note.hash);
  indexer.indexFile(before.notePath);
  const renamed = (await call("GET", "/api/cards?group=数学")).json.items[0];
  assert.equal(renamed.title, "贝叶斯公式");
  assert.notEqual(renamed.id, before.id);
  assert.equal(renamed.mastery, "learning");
  assert.equal(renamed.reps, 1);
});
