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
let base: string;
let store: NoteStore;
let db: ReturnType<typeof openDb>;
let indexer: Indexer;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sn-api-"));
  const notesRoot = path.join(tmp, "notes");
  let clock = new Date(2026, 9, 30, 10, 0, 0).getTime();
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

async function call(
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test("创建 → 列表 → 单条读取", async () => {
  const created = await call("POST", "/api/notes", {
    title: "反向传播",
    body: "梯度沿着计算图反向流动 #深度学习",
    tags: ["深度学习"],
  });
  assert.equal(created.status, 201);
  const id = created.json.id as string;
  assert.ok(id);

  const list = await call("GET", "/api/notes");
  assert.equal(list.status, 200);
  const item = (list.json.items as any[]).find((n) => n.id === id);
  assert.ok(item);
  assert.equal(item.title, "反向传播");
  assert.deepEqual(item.tags, ["深度学习"]);

  const one = await call("GET", `/api/notes/${id}`);
  assert.equal(one.status, 200);
  assert.ok(one.json.body.includes("梯度"));
  assert.equal(typeof one.json.hash, "string");
  assert.ok(one.json.relPath.endsWith(".md"));
});

test("保存：baseHash 正确时更新，过期时 409 且不覆盖磁盘", async () => {
  const created = await call("POST", "/api/notes", { title: "会被改", body: "第一版" });
  const id = created.json.id as string;
  const hash = created.json.hash as string;

  const ok = await call("PUT", `/api/notes/${id}`, { body: "第二版", baseHash: hash });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.body.includes("第二版"));

  const stale = await call("PUT", `/api/notes/${id}`, { body: "偷偷覆盖", baseHash: hash });
  assert.equal(stale.status, 409);
  assert.equal(typeof stale.json.currentHash, "string");

  const after = await call("GET", `/api/notes/${id}`);
  assert.ok(after.json.body.includes("第二版"));
  assert.ok(!after.json.body.includes("偷偷覆盖"));
});

test("快速捕获进 inbox，时间流第一条是它，标签计数正确", async () => {
  const cap = await call("POST", "/api/capture", { text: "突然想到：稀疏注意力可能更省显存 #灵感" });
  assert.equal(cap.status, 201);
  assert.ok(cap.json.relPath.startsWith("inbox/"));

  const timeline = await call("GET", "/api/timeline");
  assert.equal(timeline.status, 200);
  assert.equal(timeline.json.items[0].type, "idea");

  const tags = await call("GET", "/api/tags");
  assert.equal(tags.status, 200);
  const insp = (tags.json.items as any[]).find((t) => t.tag === "灵感");
  assert.ok(insp);
  assert.ok(insp.count >= 1);
});

test("反查链接：A 引用 B 后 B 的反查里出现 A", async () => {
  const b = await call("POST", "/api/notes", { title: "注意力机制", body: "QKV 三步" });
  const a = await call("POST", "/api/notes", { title: "读论文笔记", body: "今天读了 [[注意力机制]] 那篇" });
  const backlinks = await call("GET", `/api/backlinks/${b.json.id}`);
  assert.equal(backlinks.status, 200);
  const titles = (backlinks.json.backlinks as any[]).map((x) => x.title);
  assert.ok(titles.includes("读论文笔记"));
  assert.ok(backlinks.json.outlinks.length >= 0);
  assert.ok(a.json.id);
});

test("删除进回收站、可恢复；未知 id 返回 404", async () => {
  const created = await call("POST", "/api/notes", { title: "误删的", body: "内容" });
  const id = created.json.id as string;
  const del = await call("DELETE", `/api/notes/${id}`);
  assert.equal(del.status, 200);

  const trash = await call("GET", "/api/trash");
  assert.equal(trash.status, 200);
  assert.equal(trash.json.items.length, 1);
  const name = trash.json.items[0].name as string;

  const restored = await call("POST", `/api/trash/${encodeURIComponent(name)}/restore`);
  assert.equal(restored.status, 200);
  const back = await call("GET", `/api/notes/${id}`);
  assert.equal(back.status, 200);

  const missing = await call("GET", "/api/notes/deadbeef");
  assert.equal(missing.status, 404);
});

test("检索接口与单文件重建索引接口", async () => {
  await call("POST", "/api/notes", { title: "索引结构笔记", body: "HNSW 图结构很适合做向量检索" });
  const s = await call("GET", `/api/search?q=${encodeURIComponent("向量")}`);
  assert.equal(s.status, 200);
  assert.ok((s.json.items as any[]).length > 0);
  assert.ok((s.json.items[0].snippet as string).includes("<mark>向量</mark>"));

  const created = await call("POST", "/api/notes", { title: "手动重建", body: "内容" });
  const idx = await call("POST", "/api/index/file", { path: created.json.relPath });
  assert.equal(idx.status, 200);

  const reindex = await call("POST", "/api/reindex");
  assert.equal(reindex.status, 200);
  assert.ok(reindex.json.indexed >= 1);
});

test("坏 JSON 返回 400，未知 /api 路径返回 404", async () => {
  const bad = await fetch(`${base}/api/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{不是 json",
  });
  assert.equal(bad.status, 400);
  const unknown = await call("GET", "/api/nope");
  assert.equal(unknown.status, 404);
});
