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
import {
  attachmentFileName,
  imageMarkdown,
  relativeFromNote,
  safeBaseName,
  saveAttachment,
  sniffImage,
} from "../attachments.ts";

/** 1×1 的真 PNG */
export const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let tmp: string;
let server: http.Server;
let base: string;
let store: NoteStore;
let db: ReturnType<typeof openDb>;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sn-attach-"));
  const notesRoot = path.join(tmp, "notes");
  store = new NoteStore({
    notesRoot,
    historyDir: path.join(tmp, "history"),
    trashDir: path.join(tmp, "trash"),
    now: () => new Date(2026, 10, 14, 15, 30, 12),
  });
  db = openDb(path.join(tmp, "index.db"));
  const indexer = new Indexer({ db, store });
  const api = createApi({ store, indexer, db, now: () => new Date(2026, 10, 14, 15, 30, 12) });
  server = http.createServer(createApp({ dataDir: tmp, notesRoot, distDir: path.join(tmp, "dist"), api }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function call(method: string, p: string, body?: unknown): Promise<{ status: number; json: any; res: Response }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.clone().text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, res };
}

async function newNote(title: string, inInbox = false): Promise<{ id: string; relPath: string }> {
  const created = await call("POST", inInbox ? "/api/capture" : "/api/notes", inInbox ? { text: title } : { title, body: "正文" });
  assert.equal(created.status, 201);
  return { id: created.json.id, relPath: created.json.relPath };
}

test("sniffImage：按文件头认 PNG / JPEG / GIF / WebP，其他一律不认", () => {
  assert.equal(sniffImage(PNG_1PX), "png");
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), "jpg");
  assert.equal(sniffImage(Buffer.from("GIF89a....")), "gif");
  assert.equal(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "webp");
  assert.equal(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")), null);
  assert.equal(sniffImage(Buffer.from("就是一段文字，扩展名改成了 .png")), null);
  assert.equal(sniffImage(Buffer.alloc(0)), null);
});

test("safeBaseName：去掉 Windows 非法字符、空白、保留名，中文保留，截到 40 字", () => {
  assert.equal(safeBaseName("板书.jpg"), "板书");
  assert.equal(safeBaseName('a<b>c:"d/e\\f|g?h*.png'), "abcdefgh");
  assert.equal(safeBaseName("屏幕 截图 (2).png"), "屏幕-截图-2");
  assert.equal(safeBaseName("..hidden.png"), "hidden");
  assert.equal(safeBaseName("CON.png"), "");
  assert.equal(safeBaseName("???.png"), "");
  assert.equal([...safeBaseName(`${"长".repeat(60)}.png`)].length, 40);
});

test("attachmentFileName：有名字用名字，没有用日期时间", () => {
  const now = new Date(2026, 10, 14, 15, 30, 12);
  assert.equal(attachmentFileName({ kind: "png", hash8: "a1b2c3d4", now }), "20261114-153012-a1b2c3d4.png");
  assert.equal(attachmentFileName({ name: "板书.JPG", kind: "jpg", hash8: "a1b2c3d4", now }), "板书-a1b2c3d4.jpg");
  assert.equal(attachmentFileName({ name: "???", kind: "gif", hash8: "a1b2c3d4", now }), "20261114-153012-a1b2c3d4.gif");
  // 浏览器给剪贴板截图的通用名字
  assert.equal(attachmentFileName({ name: "image.png", kind: "png", hash8: "a1b2c3d4", now }), "20261114-153012-a1b2c3d4.png");
  assert.equal(attachmentFileName({ name: "Image.PNG", kind: "png", hash8: "a1b2c3d4", now }), "20261114-153012-a1b2c3d4.png");
});

test("relativeFromNote / imageMarkdown：相对于笔记所在目录", () => {
  assert.equal(relativeFromNote("note.md", "attachments/x.png"), "attachments/x.png");
  assert.equal(relativeFromNote("inbox/idea.md", "attachments/x.png"), "../attachments/x.png");
  assert.equal(relativeFromNote("a/b/c.md", "attachments/x.png"), "../../attachments/x.png");
  assert.equal(imageMarkdown("inbox/idea.md", "attachments/x.png"), "![](../attachments/x.png)");
});

test("saveAttachment：同一张图只存一份；空 / 假图 / 太大被拒", () => {
  const first = saveAttachment(store, { noteRelPath: "a.md", data: PNG_1PX, now: new Date(2026, 10, 14, 9, 0, 0) });
  const again = saveAttachment(store, { noteRelPath: "inbox/b.md", name: "别的名字.png", data: PNG_1PX });
  assert.equal(first.reused, false);
  assert.equal(again.reused, true);
  assert.equal(again.relPath, first.relPath);
  assert.equal(again.markdown, `![](../${first.relPath})`);
  assert.throws(() => saveAttachment(store, { noteRelPath: "a.md", data: Buffer.alloc(0) }), /空/);
  assert.throws(() => saveAttachment(store, { noteRelPath: "a.md", data: Buffer.from("<svg/>") }), /只支持/);
  const huge = Buffer.concat([PNG_1PX, Buffer.alloc(15 * 1024 * 1024)]);
  assert.throws(() => saveAttachment(store, { noteRelPath: "a.md", data: huge }), /超过/);
  // 目录里没有留下临时文件
  assert.deepEqual(
    fs.readdirSync(path.join(store.notesRoot, "attachments")).filter((f) => f.endsWith(".tmp")),
    [],
  );
});

test("POST /api/attachments：存进 attachments/，返回相对笔记的 markdown；子目录笔记带 ../", async () => {
  const note = await newNote("有图的笔记");
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("假装是 jpeg 的其余部分")]);
  const up = await call("POST", "/api/attachments", { noteId: note.id, name: "板书.jpg", dataBase64: jpg.toString("base64") });
  assert.equal(up.status, 201);
  assert.match(up.json.relPath, /^attachments\/板书-[0-9a-f]{8}\.jpg$/);
  assert.equal(up.json.markdown, `![](${up.json.relPath})`);
  assert.deepEqual(fs.readFileSync(path.join(store.notesRoot, up.json.relPath)), jpg);

  const idea = await newNote("收件箱里的想法", true);
  assert.ok(idea.relPath.startsWith("inbox/"));
  const up2 = await call("POST", "/api/attachments", { noteId: idea.id, dataBase64: PNG_1PX.toString("base64") });
  assert.equal(up2.status, 201);
  assert.match(up2.json.markdown, /^!\[\]\(\.\.\/attachments\/[^)]+\.png\)$/);
});

test("POST /api/attachments：假图 415、缺参数 400、笔记不存在 404、超过上限 413", async () => {
  const note = await newNote("错误情况");
  const svg = await call("POST", "/api/attachments", {
    noteId: note.id,
    name: "x.svg",
    dataBase64: Buffer.from("<svg onload='alert(1)'/>").toString("base64"),
  });
  assert.equal(svg.status, 415);
  assert.match(svg.json.error, /只支持/);
  assert.equal((await call("POST", "/api/attachments", { noteId: note.id })).status, 400);
  assert.equal((await call("POST", "/api/attachments", { noteId: "nope", dataBase64: PNG_1PX.toString("base64") })).status, 404);
  const big = Buffer.concat([PNG_1PX, Buffer.alloc(16 * 1024 * 1024)]);
  const tooBig = await call("POST", "/api/attachments", { noteId: note.id, dataBase64: big.toString("base64") });
  assert.equal(tooBig.status, 413);
  // 别的写接口仍是 5MB 上限
  const other = await call("POST", "/api/notes", { title: "大", body: "字".repeat(2 * 1024 * 1024) });
  assert.equal(other.status, 413);
});

test("GET /api/files：能读库里的图片（带 nosniff 和 ETag），304 生效", async () => {
  const note = await newNote("读图");
  const up = await call("POST", "/api/attachments", { noteId: note.id, dataBase64: PNG_1PX.toString("base64") });
  const url = `/api/files/${up.json.relPath.split("/").map(encodeURIComponent).join("/")}`;
  const res = await fetch(`${base}${url}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG_1PX);
  const etag = res.headers.get("etag")!;
  const again = await fetch(`${base}${url}`, { headers: { "if-none-match": etag } });
  assert.equal(again.status, 304);
});

test("GET /api/files：越界、.md、隐藏目录、不存在一律 404；SVG 带 sandbox", async () => {
  fs.writeFileSync(path.join(tmp, "secret.png"), PNG_1PX); // 笔记库外
  fs.writeFileSync(path.join(store.notesRoot, "note.md"), "# 笔记");
  fs.mkdirSync(path.join(store.notesRoot, ".hidden"), { recursive: true });
  fs.writeFileSync(path.join(store.notesRoot, ".hidden", "x.png"), PNG_1PX);
  fs.writeFileSync(path.join(store.notesRoot, "pic.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  // 指到库外的目录链接（Windows 上是 junction）
  fs.symlinkSync(tmp, path.join(store.notesRoot, "outside"), "junction");

  for (const p of [
    "/api/files/..%2Fsecret.png",
    "/api/files/../secret.png",
    "/api/files/note.md",
    "/api/files/.hidden/x.png",
    "/api/files/nope.png",
    "/api/files/outside/secret.png",
    "/api/files/%2E%2E/secret.png",
  ]) {
    const res = await fetch(`${base}${p}`);
    assert.equal(res.status, 404, p);
  }
  const svg = await fetch(`${base}/api/files/pic.svg`);
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get("content-security-policy") ?? "", /sandbox/);
});

test("GET /api/files?fallback：首选位置没有时读备选位置；备选越界照样 404", async () => {
  fs.mkdirSync(path.join(store.notesRoot, "attachments"), { recursive: true });
  fs.writeFileSync(path.join(store.notesRoot, "attachments", "only-here.png"), PNG_1PX);
  const ok = await fetch(`${base}/api/files/inbox/only-here.png?fallback=${encodeURIComponent("attachments/only-here.png")}`);
  assert.equal(ok.status, 200);
  const bad = await fetch(`${base}/api/files/inbox/x.png?fallback=${encodeURIComponent("../secret.png")}`);
  assert.equal(bad.status, 404);
});
