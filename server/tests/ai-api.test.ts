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
let db: ReturnType<typeof openDb>;

const fakeAi = (async () =>
  new Response(
    [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "你" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "好" } }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )) as unknown as typeof fetch;

before(async () => {
  process.env.STUDY_AI_KEY = "sk-test-abcdefghijklmn";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sn-aiapi-"));
  const notesRoot = path.join(tmp, "notes");
  const store = new NoteStore({
    notesRoot,
    historyDir: path.join(tmp, "history"),
    trashDir: path.join(tmp, "trash"),
  });
  db = openDb(path.join(tmp, "index.db"));
  const indexer = new Indexer({ db, store });
  const api = createApi({ store, indexer, db, dataDir: tmp, aiFetch: fakeAi });
  const app = createApp({ dataDir: tmp, notesRoot, distDir: path.join(tmp, "dist"), api });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  delete process.env.STUDY_AI_KEY;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("GET /api/config 已配置时打码返回", async () => {
  const res = await fetch(`${base}/api/config`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { configured: boolean; apiKeyMasked: string; model: string };
  assert.equal(body.configured, true);
  assert.equal(body.apiKeyMasked.includes("abcdefghijklmn"), false);
  assert.ok(body.model.length > 0);
});

test("POST /api/ai/:mode 以 SSE 返回增量并以 done 结束", async () => {
  const created = await fetch(`${base}/api/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "SSE 测试", body: "正文内容" }),
  });
  const note = (await created.json()) as { id: string };

  const res = await fetch(`${base}/api/ai/summarize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ noteId: note.id }),
  });
  assert.equal(res.status, 200);
  assert.ok((res.headers.get("content-type") ?? "").includes("text/event-stream"));
  const text = await res.text();
  assert.ok(text.includes('data: {"delta":"你"}'), text);
  assert.ok(text.includes('data: {"delta":"好"}'), text);
  assert.ok(text.includes("event: done"));
  const callId = Number(/"callId":(\d+)/.exec(text.split("event: done")[1])?.[1] ?? 0);
  assert.ok(callId > 0);

  const row = db.prepare("SELECT mode, output, inserted FROM ai_calls WHERE id = ?").get(callId) as {
    mode: string;
    output: string;
    inserted: number;
  };
  assert.equal(row.mode, "summarize");
  assert.equal(row.output, "你好");
  assert.equal(row.inserted, 0);

  const accept = await fetch(`${base}/api/ai/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callId }),
  });
  assert.equal(accept.status, 200);
  const after = db.prepare("SELECT inserted FROM ai_calls WHERE id = ?").get(callId) as { inserted: number };
  assert.equal(after.inserted, 1);
});

test("未知动作返回 404", async () => {
  const res = await fetch(`${base}/api/ai/nope`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 404);
});


test("上游连接被重置：自动重试一次就成功（不再只报 fetch failed）", async () => {
  let calls = 0;
  const flaky = (async () => {
    calls += 1;
    if (calls === 1) {
      throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
    }
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "重试成功" } }] })}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;

  const { createApi: createApiWithFetch } = await import("../api.ts");
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "sn-ai-retry-"));
  process.env.STUDY_AI_KEY = "sk-test-abcdefghijklmn";
  const store = new NoteStore({
    notesRoot: path.join(tmp2, "notes"),
    historyDir: path.join(tmp2, "history"),
    trashDir: path.join(tmp2, "trash"),
  });
  const db2 = openDb(path.join(tmp2, "index.db"));
  const indexer = new Indexer({ db: db2, store });
  const api = createApiWithFetch({ store, indexer, db: db2, dataDir: tmp2, aiFetch: flaky });
  const app = createApp({ dataDir: tmp2, notesRoot: store.notesRoot, distDir: path.join(tmp2, "dist"), api });
  const srv = http.createServer(app);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

  try {
    const res = await fetch(`${url}/api/ai/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "重试", body: "正文" }),
    });
    const text = await res.text();
    assert.ok(text.includes("重试成功"), text);
    assert.equal(calls, 2, "第一次失败后应当重试一次");
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    db2.close();
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
});

test("上游一直连不上：错误码变成 AI_NETWORK，话里带原因", async () => {
  const dead = (async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
  }) as unknown as typeof fetch;

  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), "sn-ai-netdown-"));
  process.env.STUDY_AI_KEY = "sk-test-abcdefghijklmn";
  const store = new NoteStore({
    notesRoot: path.join(tmp3, "notes"),
    historyDir: path.join(tmp3, "history"),
    trashDir: path.join(tmp3, "trash"),
  });
  const db3 = openDb(path.join(tmp3, "index.db"));
  const indexer = new Indexer({ db: db3, store });
  const api = createApi({ store, indexer, db: db3, dataDir: tmp3, aiFetch: dead });
  const app = createApp({ dataDir: tmp3, notesRoot: store.notesRoot, distDir: path.join(tmp3, "dist"), api });
  const srv = http.createServer(app);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

  try {
    const res = await fetch(`${url}/api/ai/summarize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "断网", body: "正文" }),
    });
    const text = await res.text();
    assert.ok(text.includes('"code":"AI_NETWORK"'), text);
    assert.ok(text.includes("连接被对端重置"), text);
    assert.ok(text.includes("已重试 1 次"), text);
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    db3.close();
    fs.rmSync(tmp3, { recursive: true, force: true });
  }
});
