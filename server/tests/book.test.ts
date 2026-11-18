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
import { NoteStore } from "../store.ts";
import { appendIndexLinks, indexBody, indexLinkTitles, insertIndexLinkAfter, pickIndex } from "../book.ts";

// ---- 纯函数 ----

test("indexLinkTitles：按出现顺序、去重、忽略自身与嵌入图片", () => {
  const body = "总览文字\n\n1. [[B]]\n2. [[A|别名]]\n3. [[B]]\n![[图.png]]\n见 [[目录]] 与 [[C#小节]]\n";
  assert.deepEqual(indexLinkTitles(body, "目录"), ["B", "A", "C"]);
});

test("pickIndex：type index 优先且取最早创建；否则标题叫「目录」；多篇目录报告其余", () => {
  const rows = [
    { id: "1", type: "note", title: "目录", created: "2026-01-01" },
    { id: "2", type: "index", title: "新目录", created: "2026-03-01" },
    { id: "3", type: "index", title: "旧目录", created: "2026-02-01" },
  ];
  const picked = pickIndex(rows);
  assert.equal(picked.index?.id, "3");
  assert.deepEqual(picked.others.map((row) => row.id), ["2"]);
  assert.equal(pickIndex(rows.slice(0, 1)).index?.id, "1");
  assert.equal(pickIndex([{ id: "x", type: "note", title: "别的", created: "1" }]).index, null);
});

test("indexBody / appendIndexLinks：追加到末尾、沿用换行符、已在目录里的不重复", () => {
  assert.equal(indexBody(["A", "B"]), "- [[A]]\n- [[B]]\n");
  assert.equal(indexBody([]), "");
  assert.equal(appendIndexLinks("总览\n\n- [[A]]\n\n\n", ["B", "A", "B"], "目录"), "总览\n\n- [[A]]\n- [[B]]\n");
  assert.equal(appendIndexLinks("x\r\n- [[A]]\r\n", ["C"], "目录"), "x\r\n- [[A]]\r\n- [[C]]\r\n");
  assert.equal(appendIndexLinks("", ["A"], "目录"), "- [[A]]\n");
  const same = "- [[A]]\n";
  assert.equal(appendIndexLinks(same, ["A"], "目录"), same);
});

test("insertIndexLinkAfter：插在链到 after 的那一行之后，沿用缩进和列表符号；找不到就追加；已有不重复", () => {
  const body = "总览\n\n1. [[A]]\n2. [[B]]\n";
  assert.equal(insertIndexLinkAfter(body, "A", "新", "目录"), "总览\n\n1. [[A]]\n2. [[新]]\n2. [[B]]\n");
  assert.equal(insertIndexLinkAfter("- [[A]]\n  * [[A1|别名]]\n- [[B]]\n", "A1", "新", "目录"), "- [[A]]\n  * [[A1|别名]]\n  * [[新]]\n- [[B]]\n");
  assert.equal(insertIndexLinkAfter("x\r\n- [[A]]\r\n- [[B]]\r\n", "A", "C", "目录"), "x\r\n- [[A]]\r\n- [[C]]\r\n- [[B]]\r\n");
  assert.equal(insertIndexLinkAfter("先看 [[A]] 再说\n", "A", "C", "目录"), "先看 [[A]] 再说\n- [[C]]\n");
  assert.equal(insertIndexLinkAfter("- [[A]]\n", "不在目录里", "C", "目录"), "- [[A]]\n- [[C]]\n");
  assert.equal(insertIndexLinkAfter("- [[A]]\n", null, "C", "目录"), "- [[A]]\n- [[C]]\n");
  assert.equal(insertIndexLinkAfter("- [[A]]\n- [[C]]\n", "A", "C", "目录"), "- [[A]]\n- [[C]]\n");
});

// ---- 接口 ----

let tmp: string;
let server: http.Server;
let base: string;
let store: NoteStore;
let db: ReturnType<typeof openDb>;
let indexer: Indexer;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sn-book-"));
  const notesRoot = path.join(tmp, "notes");
  let clock = new Date(2026, 10, 18, 9, 0, 0).getTime();
  store = new NoteStore({
    notesRoot,
    historyDir: path.join(tmp, "history"),
    trashDir: path.join(tmp, "trash"),
    now: () => new Date((clock += 60000)),
  });
  db = openDb(path.join(tmp, "index.db"));
  indexer = new Indexer({ db, store });
  const api = createApi({ store, indexer, db });
  const app = createApp({ dataDir: tmp, notesRoot, distDir: path.join(tmp, "dist"), api });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
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

function note(title: string, group: string | undefined, body = `${title} 的正文`, type?: "index") {
  const created = store.create({ title, body, group, type });
  indexer.indexFile(created.relPath);
  return created;
}

const book = (group: string) => call("GET", `/api/book?group=${encodeURIComponent(group)}`);

test("没有目录：按创建时间连读，index 为 null", async () => {
  note("第一篇", "无目录/项目");
  note("第二篇", "无目录/项目");
  const res = await book("无目录/项目");
  assert.equal(res.status, 200);
  assert.equal(res.json.index, null);
  assert.deepEqual(res.json.chapters.map((c: any) => c.title), ["第一篇", "第二篇"]);
  assert.equal(res.json.chapters[0].body, "第一篇 的正文");
  assert.ok(res.json.chapters[0].hash);
});

test("有目录：按链接顺序；外来章标 foreign；缺章占位；没写进目录的进 unlisted；子项目的笔记不算进父分组", async () => {
  note("looprun 实现", "agent/looprun");
  note("踩坑记录", "agent/looprun");
  note("没排进去的", "agent/looprun");
  note("trace 实现", "agent/trace");
  note("子子", "agent/looprun"); // 同组
  note("父分组直接的", "agent");
  note(
    "looprun 目录",
    "agent/looprun",
    "looprun 是一个循环。\n\n1. [[踩坑记录]]\n2. [[trace 实现]]\n3. [[还没写]]\n4. [[looprun 实现]]\n5. [[子子]]\n",
    "index",
  );
  const res = await book("agent/looprun");
  assert.equal(res.json.index.title, "looprun 目录");
  assert.match(res.json.index.body, /循环/);
  assert.deepEqual(
    res.json.chapters.map((c: any) => [c.kind, c.title, c.foreign ?? null]),
    [
      ["note", "踩坑记录", false],
      ["note", "trace 实现", true],
      ["missing", "还没写", null],
      ["note", "looprun 实现", false],
      ["note", "子子", false],
    ],
  );
  assert.deepEqual(res.json.unlisted.map((n: any) => n.title), ["没排进去的"]);
  assert.deepEqual(res.json.otherIndexes, []);

  const parent = await book("agent");
  assert.deepEqual(parent.json.chapters.map((c: any) => c.title), ["父分组直接的"]);
});

test("标题叫「目录」的普通笔记也算目录；多篇 type index 时报告其余", async () => {
  note("甲", "手写");
  note("目录", "手写", "- [[甲]]\n");
  const hand = await book("手写");
  assert.equal(hand.json.index.title, "目录");
  assert.deepEqual(hand.json.chapters.map((c: any) => c.title), ["甲"]);

  note("一号目录", "多目录", "- [[乙]]\n", "index");
  note("乙", "多目录");
  note("二号目录", "多目录", "", "index");
  const multi = await book("多目录");
  assert.equal(multi.json.index.title, "一号目录");
  assert.deepEqual(multi.json.otherIndexes, ["二号目录"]);
  assert.deepEqual(multi.json.unlisted, []);
});

test("POST /api/book/index：没有目录时生成（type index，按创建时间）", async () => {
  note("生成一", "生成/项目");
  note("生成二", "生成/项目");
  const res = await call("POST", "/api/book/index", { group: "生成/项目" });
  assert.equal(res.status, 200);
  assert.equal(res.json.created, true);
  const b = await book("生成/项目");
  assert.equal(b.json.index.title, "项目 目录");
  assert.deepEqual(b.json.chapters.map((c: any) => c.title), ["生成一", "生成二"]);
  const raw = store.read(
    (db.prepare("SELECT path FROM notes WHERE id = ?").get(res.json.index.id) as { path: string }).path,
  ).raw;
  assert.match(raw, /^type: index$/m);
  assert.match(raw, /^group: 生成\/项目$/m);
});

test("POST /api/book/index：已有目录时追加，baseHash 过期返回 409", async () => {
  note("追加甲", "追加");
  note("追加乙", "追加");
  note("追加 目录", "追加", "总览\n\n- [[追加甲]]\n", "index");
  const before = await book("追加");
  assert.deepEqual(before.json.unlisted.map((n: any) => n.title), ["追加乙"]);

  const stale = await call("POST", "/api/book/index", { group: "追加", titles: ["追加乙"], baseHash: "旧的" });
  assert.equal(stale.status, 409);
  assert.ok(stale.json.currentHash);

  const ok = await call("POST", "/api/book/index", {
    group: "追加",
    titles: ["追加乙"],
    baseHash: before.json.index.hash,
  });
  assert.equal(ok.status, 200);
  const after = await book("追加");
  assert.deepEqual(after.json.chapters.map((c: any) => c.title), ["追加甲", "追加乙"]);
  assert.deepEqual(after.json.unlisted, []);
  assert.equal(after.json.index.body, "总览\n\n- [[追加甲]]\n- [[追加乙]]\n");
});

test("参数错误：缺 group、三层组名、已有目录却不给 titles", async () => {
  assert.equal((await call("GET", "/api/book")).status, 400);
  assert.equal((await book("a/b/c")).status, 400);
  const res = await call("POST", "/api/book/index", { group: "追加" });
  assert.equal(res.status, 400);
});

test("POST /api/book/chapters：在某章之后新建，归入该组并插进目录", async () => {
  const a = note("新章甲", "新章/项目");
  note("新章乙", "新章/项目");
  note("项目 目录", "新章/项目", "总览\n\n1. [[新章甲]]\n2. [[新章乙]]\n", "index");
  const before = await book("新章/项目");
  const res = await call("POST", "/api/book/chapters", {
    group: "新章/项目",
    title: "插进来的",
    after: a.id,
    baseHash: before.json.index.hash,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.index.created, false);
  const after = await book("新章/项目");
  assert.deepEqual(after.json.chapters.map((c: any) => c.title), ["新章甲", "插进来的", "新章乙"]);
  assert.equal(after.json.chapters[1].id, res.json.note.id);
  assert.equal(after.json.chapters[1].group, "新章/项目");
  assert.equal(after.json.index.hash, res.json.index.hash);

  // 不给 after：追加到末尾
  await call("POST", "/api/book/chapters", { group: "新章/项目", title: "最后一章", baseHash: res.json.index.hash });
  const tail = await book("新章/项目");
  assert.equal(tail.json.chapters.at(-1).title, "最后一章");
});

test("POST /api/book/chapters：没有目录时先生成；目录过期返回 409 但笔记已建好；非法标题与重名 400", async () => {
  const first = note("无目录甲", "新章/无目录");
  note("无目录乙", "新章/无目录");
  const made = await call("POST", "/api/book/chapters", { group: "新章/无目录", title: "夹在中间", after: first.id });
  assert.equal(made.status, 200);
  assert.equal(made.json.index.created, true);
  const b = await book("新章/无目录");
  assert.equal(b.json.index.title, "无目录 目录");
  assert.deepEqual(b.json.chapters.map((c: any) => c.title), ["无目录甲", "夹在中间", "无目录乙"]);

  const stale = await call("POST", "/api/book/chapters", { group: "新章/无目录", title: "冲突章", baseHash: "旧的" });
  assert.equal(stale.status, 409);
  assert.match(stale.json.error, /已建好/);
  assert.ok(stale.json.note.id);
  const afterStale = await book("新章/无目录");
  assert.deepEqual(afterStale.json.unlisted.map((n: any) => n.title), ["冲突章"]);

  assert.equal((await call("POST", "/api/book/chapters", { group: "新章/无目录", title: "坏[[标题" })).status, 400);
  assert.equal((await call("POST", "/api/book/chapters", { group: "新章/无目录", title: "  " })).status, 400);
  assert.equal((await call("POST", "/api/book/chapters", { group: "新章/无目录", title: "无目录甲" })).status, 400);
  assert.equal((await call("POST", "/api/book/chapters", { group: "新章/无目录", title: "x", after: "不存在" })).status, 400);
});
