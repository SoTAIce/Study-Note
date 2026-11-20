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
import { DEFAULT_MANUAL_DIR, indexBody, loadManual, manualVersionOf } from "../help.ts";

let tmp: string;
let notesRoot: string;
let manualDir: string;
let server: http.Server;
let base: string;
let db: ReturnType<typeof openDb>;

function writeManual(extra = ""): void {
  fs.mkdirSync(manualDir, { recursive: true });
  fs.writeFileSync(path.join(manualDir, "01-a.md"), "---\ntitle: 手册：甲\npart: 第一部分\n---\n\n## 甲\n\n见 [[手册：乙]]。\n");
  fs.writeFileSync(path.join(manualDir, "02-b.md"), `---\ntitle: 手册：乙\npart: 第一部分\n---\n\n乙的正文${extra}\n`);
  fs.writeFileSync(path.join(manualDir, "03-c.md"), "---\ntitle: 手册：丙\npart: 第二部分\n---\n\n概念 :: 解释\n");
  fs.writeFileSync(path.join(manualDir, "README.txt"), "不算章节");
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sn-help-"));
  notesRoot = path.join(tmp, "notes");
  manualDir = path.join(tmp, "manual");
  writeManual();
  const store = new NoteStore({ notesRoot, historyDir: path.join(tmp, "history"), trashDir: path.join(tmp, "trash") });
  db = openDb(path.join(tmp, "index.db"));
  const indexer = new Indexer({ db, store });
  const api = createApi({ store, indexer, db, dataDir: tmp, manualDir });
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

async function call(method: string, url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${url}`, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

type Note = { id: string; title: string; group: string | null; relPath: string; type: string };
async function notesIn(group: string): Promise<Note[]> {
  return ((await (await fetch(`${base}/api/notes?group=${encodeURIComponent(group)}`)).json()) as { items: Note[] }).items;
}

test("仓库自带的手册：12 章、三个部分、每章都有「动手试试」、章内链接都指向手册里的章", () => {
  const manual = loadManual(DEFAULT_MANUAL_DIR);
  assert.equal(manual.chapters.length, 12);
  assert.deepEqual([...new Set(manual.chapters.map((chapter) => chapter.part))], ["写笔记基础", "模板与 AI", "复习与备份"]);
  const titles = new Set(manual.chapters.map((chapter) => chapter.title));
  for (const chapter of manual.chapters) {
    assert.ok(chapter.title.startsWith("手册："), chapter.slug);
    assert.match(chapter.body, /^## 动手试试$/m, `${chapter.title} 缺「动手试试」`);
    for (const link of chapter.body.matchAll(/\[\[([^\]|#]+)/g)) {
      if (link[1].startsWith("手册：")) assert.ok(titles.has(link[1]), `${chapter.title} 里的 [[${link[1]}]] 找不到`);
    }
  }
  assert.match(manual.version, /^[0-9a-f]{8}$/);
});

test("manual: 行的识别；目录正文按部分分节、每章一个双链", () => {
  assert.equal(manualVersionOf("---\ntitle: x\nmanual: abcd1234\n---\n正文"), "abcd1234");
  assert.equal(manualVersionOf("---\ntitle: x\n---\nmanual: 正文里的不算"), null);
  assert.equal(manualVersionOf("没有文件头"), null);
  const body = indexBody(loadManual(manualDir));
  assert.match(body, /## 第一部分\n\n- \[\[手册：甲\]\]\n- \[\[手册：乙\]\]\n\n## 第二部分\n\n- \[\[手册：丙\]\]/);
});

test("读手册：章节按文件名排序、只认数字开头的 .md；没装时 installed.count = 0", async () => {
  const { status, body } = await call("GET", "/api/help/manual");
  assert.equal(status, 200);
  const chapters = body.chapters as Array<{ slug: string; title: string; part: string; body: string }>;
  assert.deepEqual(chapters.map((chapter) => chapter.slug), ["01-a", "02-b", "03-c"]);
  assert.equal(chapters[0].body, "## 甲\n\n见 [[手册：乙]]。\n");
  assert.deepEqual(body.installed, { count: 0, version: null });
});

test("生成练习笔记：子项目里每章一篇 + 目录，文件头带 manual:；连读按目录顺序；再生成一次 409", async () => {
  const { status, body } = await call("POST", "/api/help/manual/install");
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.group, "使用手册/练习");
  const version = (body as { version: string }).version;
  assert.deepEqual(body.installed, { count: 4, version });
  const notes = await notesIn("使用手册/练习");
  assert.deepEqual(notes.map((note) => note.title).sort(), ["使用手册 · 目录", "手册：丙", "手册：乙", "手册：甲"].sort());
  for (const note of notes) {
    const raw = fs.readFileSync(path.join(notesRoot, note.relPath), "utf8");
    assert.equal(manualVersionOf(raw), version, note.title);
  }
  assert.equal(notes.find((note) => note.title === "使用手册 · 目录")?.type, "index");
  const book = (await (await fetch(`${base}/api/book?group=${encodeURIComponent("使用手册/练习")}`)).json()) as { chapters: Array<{ title: string }> };
  assert.deepEqual(book.chapters.map((chapter) => chapter.title), ["手册：甲", "手册：乙", "手册：丙"]);
  const groups = fs.readFileSync(path.join(tmp, "groups.json"), "utf8");
  assert.ok(groups.includes("使用手册/练习"));

  const again = await call("POST", "/api/help/manual/install");
  assert.equal(again.status, 409);
  assert.equal((await notesIn("使用手册/练习")).length, 4, "409 时不该多出笔记");
});

test("重新生成：改过的旧练习笔记进回收站，新版齐全；同组里手写的笔记不动", async () => {
  // 在练习组里手写一篇（没有 manual: 行），再改一篇练习笔记
  const own = await fetch(`${base}/api/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "我自己写的", body: "不是练习笔记", group: "使用手册/练习" }),
  });
  assert.equal(own.status, 201);
  const edited = (await notesIn("使用手册/练习")).find((note) => note.title === "手册：甲")!;
  const file = path.join(notesRoot, edited.relPath);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("见 [[手册：乙]]。", "见 [[手册：乙]]。我练习时加的一句。"));
  writeManual("（新版）");

  const { status, body } = await call("POST", "/api/help/manual/reinstall");
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.trashed, 4);
  const notes = await notesIn("使用手册/练习");
  assert.equal(notes.length, 5, "新版 4 篇 + 自己写的 1 篇");
  assert.ok(notes.some((note) => note.title === "我自己写的"));
  const fresh = notes.find((note) => note.title === "手册：乙")!;
  assert.ok(fs.readFileSync(path.join(notesRoot, fresh.relPath), "utf8").includes("（新版）"));
  const trash = (await (await fetch(`${base}/api/trash`)).json()) as { items: Array<{ title?: string; name: string }> };
  assert.ok(JSON.stringify(trash.items).includes("手册：甲"), "改过的旧版应在回收站里");
});

test("删除练习笔记：只删带 manual: 的；组里还有手写的就留着分组", async () => {
  const { status, body } = await call("DELETE", "/api/help/manual");
  assert.equal(status, 200);
  assert.equal(body.trashed, 4);
  assert.deepEqual(body.installed, { count: 0, version: null });
  const left = await notesIn("使用手册/练习");
  assert.deepEqual(left.map((note) => note.title), ["我自己写的"]);
  assert.ok(fs.readFileSync(path.join(tmp, "groups.json"), "utf8").includes("使用手册/练习"), "组里还有笔记，分组留着");
});

test("组里没有笔记了：删除时把练习子项目和空的父分组一起清掉", async () => {
  // 先把手写那篇删掉，再装一次、删一次
  const own = (await notesIn("使用手册/练习")).find((note) => note.title === "我自己写的")!;
  assert.equal((await fetch(`${base}/api/notes/${own.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await call("POST", "/api/help/manual/install")).status, 200);
  assert.equal((await call("DELETE", "/api/help/manual")).status, 200);
  const groups = fs.readFileSync(path.join(tmp, "groups.json"), "utf8");
  assert.equal(groups.includes("使用手册"), false, groups);
});
