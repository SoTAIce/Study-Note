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
let notesRoot: string;
let server: http.Server;
let base: string;
let db: ReturnType<typeof openDb>;
/** 假模型这次要回的话；requests 记下发给模型的消息 */
let reply = "";
const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];

const fakeAi = (async (_url: string, init: RequestInit) => {
  requests.push(JSON.parse(String(init.body)));
  const chunks = reply ? [reply.slice(0, 5), reply.slice(5)] : [];
  return new Response(
    [...chunks.filter(Boolean).map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`), "data: [DONE]\n\n"].join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}) as unknown as typeof fetch;

before(async () => {
  process.env.STUDY_AI_KEY = "sk-test-abcdefghijklmn";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sn-arrange-"));
  notesRoot = path.join(tmp, "notes");
  const store = new NoteStore({ notesRoot, historyDir: path.join(tmp, "history"), trashDir: path.join(tmp, "trash") });
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

const PASTED = ["## 1. 背景", "", "起因是旧方案太慢。", "", "## 2. 实现", "", "- 用了缓存", "- 加了索引", "", "```ts", "## 代码里的不是标题", "```", "", "顺便一提"].join("\n");

async function createNote(body: string): Promise<{ id: string; hash: string; relPath: string }> {
  const res = await fetch(`${base}/api/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: `规整 ${Math.random()}`, body, template: null }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { id: string; hash: string; relPath: string };
}

function snapshotDisk(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(full, fs.readFileSync(full, "utf8"));
    }
  };
  walk(notesRoot);
  walk(path.join(tmp, "history"));
  return out;
}

async function arrange(payload: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/ai/arrange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("POST /api/ai/arrange：模型只回编号，服务端逐字拼好正文；不写盘", async () => {
  const note = await createNote(PASTED);
  // 块：0「## 1. 背景」1 起因 2「## 2. 实现」3 列表 4 代码 5 顺便一提
  reply = '好的，方案如下：\n```json\n{"背景": [1], "设计": [3], "关键代码": [4], "drop": [0, 2]}\n```';
  requests.length = 0;
  const before = snapshotDisk();
  const { status, body } = await arrange({ id: note.id, template: "实现详情", baseHash: note.hash });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.template, "实现详情");
  assert.equal(body.baseHash, note.hash);
  assert.equal((body.blocks as unknown[]).length, 6);
  const text = body.body as string;
  assert.match(text, /^## 背景\n<!-- [^\n]+ -->\n\n起因是旧方案太慢。\n\n## 设计\n/);
  assert.ok(text.includes("- 用了缓存\n- 加了索引"));
  assert.ok(text.includes("```ts\n## 代码里的不是标题\n```"));
  assert.ok(text.includes("## 踩坑\n<!-- "));
  assert.match(text, /## 待办\n<!-- [^\n]+ -->\n\n待补\n\n## 其他\n\n顺便一提\n$/);
  assert.equal(text.includes("1. 背景"), false, "被 drop 的原标题不该出现");
  assert.deepEqual((body.plan as { other: number[] }).other, [5]);
  assert.equal(typeof body.callId, "number");
  // 发给模型的是编号块和小节名
  const sent = requests[0].messages.map((message) => message.content).join("\n");
  assert.match(sent, /\[3\]\n- 用了缓存/);
  assert.match(sent, /- 关键代码/);
  assert.deepEqual(snapshotDisk(), before, "规整只出预览，不改任何文件");
});

test("模型回了坏 JSON / 想改字 / 未知小节 / 非标题进 drop：422，不写盘", async () => {
  const note = await createNote(PASTED);
  const before = snapshotDisk();
  for (const bad of [
    "我建议把第一段放到背景里",
    '{"背景": ["起因是旧方案太快。"]}',
    '{"结论": [1]}',
    '{"drop": [1]}',
    '{"背景": [1], "设计": [1]}',
    '{"背景": [42]}',
  ]) {
    reply = bad;
    const { status, body } = await arrange({ id: note.id, template: "实现详情", baseHash: note.hash });
    assert.equal(status, 422, bad);
    assert.equal(body.code, "ARRANGE_INVALID");
    assert.match(String(body.error), /正文没有改动/);
  }
  assert.deepEqual(snapshotDisk(), before);
});

test("baseHash 对不上：409 带 currentHash；模板不存在：400；正文只有骨架：400", async () => {
  const note = await createNote(PASTED);
  reply = '{"背景": [1]}';
  const stale = await arrange({ id: note.id, template: "实现详情", baseHash: "deadbeef" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.currentHash, note.hash);

  const missing = await arrange({ id: note.id, template: "没有这个模板" });
  assert.equal(missing.status, 400);
  assert.match(String(missing.body.error), /不存在/);

  const skeleton = await fetch(`${base}/api/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "只有骨架", body: "", template: "实现详情" }),
  });
  const empty = (await skeleton.json()) as { id: string };
  const onlySkeleton = await arrange({ id: empty.id, template: "实现详情" });
  assert.equal(onlySkeleton.status, 400);
  assert.equal(onlySkeleton.body.code, "EMPTY");

  const noId = await arrange({ template: "实现详情" });
  assert.equal(noId.status, 400);
});

test("模型什么都没回：502；没配置 AI：503 提示先去设置", async () => {
  const note = await createNote(PASTED);
  reply = "";
  const blank = await arrange({ id: note.id, template: "实现详情" });
  assert.equal(blank.status, 502);
  assert.equal(blank.body.code, "AI_EMPTY");

  // 环境变量和 config.json 里都没有 key（第一次调用时 key 会被记进 config.json）
  const key = process.env.STUDY_AI_KEY;
  const configPath = path.join(tmp, "config.json");
  const saved = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;
  delete process.env.STUDY_AI_KEY;
  fs.writeFileSync(configPath, JSON.stringify({ model: "m" }));
  try {
    const unconfigured = await arrange({ id: note.id, template: "实现详情" });
    assert.equal(unconfigured.status, 503);
    assert.equal(unconfigured.body.code, "AI_UNCONFIGURED");
  } finally {
    process.env.STUDY_AI_KEY = key;
    if (saved === null) fs.rmSync(configPath, { force: true });
    else fs.writeFileSync(configPath, saved);
  }
});
