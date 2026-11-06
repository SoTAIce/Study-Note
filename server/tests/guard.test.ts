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

let tmp: string;
let server: http.Server;
let port: number;
let db: ReturnType<typeof openDb>;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sn-guard-"));
  const notesRoot = path.join(tmp, "notes");
  const store = new NoteStore({
    notesRoot,
    historyDir: path.join(tmp, "history"),
    trashDir: path.join(tmp, "trash"),
  });
  db = openDb(path.join(tmp, "index.db"));
  const indexer = new Indexer({ db, store });
  const app = createApp({
    dataDir: tmp,
    notesRoot,
    distDir: path.join(tmp, "dist"),
    api: createApi({ store, indexer, db }),
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 绕开 fetch 的限制，手写请求以便自定义 Host / Origin / Content-Type。 */
function raw(options: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: options.method, path: options.path, headers: options.headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test("Host 不是本机名 → 403（挡 DNS rebinding）", async () => {
  const res = await raw({ method: "GET", path: "/api/notes", headers: { host: "evil.example:7777" } });
  assert.equal(res.status, 403);
  const ok = await raw({ method: "GET", path: "/api/health", headers: { host: "localhost:7777" } });
  assert.equal(ok.status, 200);
});

test("跨站 Origin 的写请求 → 403（挡 CSRF）", async () => {
  const body = JSON.stringify({ text: "跨站塞进来的一条" });
  const res = await raw({
    method: "POST",
    path: "/api/capture",
    headers: {
      host: `127.0.0.1:${port}`,
      origin: "https://evil.example",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    },
    body,
  });
  assert.equal(res.status, 403);
  const count = db.prepare("SELECT COUNT(*) AS n FROM notes").get() as { n: number };
  assert.equal(count.n, 0, "被拒绝的请求不该落盘");
});

test("带 body 的写请求不是 application/json → 415（挡跨站简单请求）", async () => {
  const body = JSON.stringify({ text: "text/plain 也能打进来吗" });
  const res = await raw({
    method: "POST",
    path: "/api/capture",
    headers: {
      host: `127.0.0.1:${port}`,
      "content-type": "text/plain",
      "content-length": String(Buffer.byteLength(body)),
    },
    body,
  });
  assert.equal(res.status, 415);
});

test("同源 JSON 写请求照常通过", async () => {
  const body = JSON.stringify({ text: "正常捕获一条" });
  const res = await raw({
    method: "POST",
    path: "/api/capture",
    headers: {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
    },
    body,
  });
  assert.equal(res.status, 201);
});

test("回收站恢复：越界或非 .md 的条目名一律拒绝，且不动原文件", async () => {
  const notesRoot = path.join(tmp, "notes");
  const trashDir = path.join(tmp, "trash");
  const store = new NoteStore({
    notesRoot,
    historyDir: path.join(tmp, "history"),
    trashDir,
  });
  fs.mkdirSync(trashDir, { recursive: true });
  fs.writeFileSync(path.join(tmp, "config.json"), '{"apiKey":"sk-should-not-leak"}', "utf8");

  for (const bad of ["../config.json", "..", "../../etc/passwd.md", "C:\\Windows\\notepad.exe", "config.json"]) {
    assert.throws(() => store.restore(bad), /非法的回收站条目名/, `应拒绝 ${bad}`);
  }
  assert.equal(fs.existsSync(path.join(tmp, "config.json")), true, "config.json 必须原地不动");
  assert.equal(fs.existsSync(path.join(notesRoot, "config.json")), false);
});
