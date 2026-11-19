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
  const chunks = reply ? [reply.slice(0, 7), reply.slice(7)] : [];
  return new Response(
    [...chunks.filter(Boolean).map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`), "data: [DONE]\n\n"].join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}) as unknown as typeof fetch;

before(async () => {
  process.env.STUDY_AI_KEY = "sk-test-abcdefghijklmn";
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sn-tplgen-"));
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

const GOOD = {
  name: "论文阅读",
  sections: [
    { title: "问题", hint: "论文要解决什么" },
    { title: "方法", hint: "怎么做的" },
    { title: "实验", hint: "数据、对比、结论" },
  ],
  prompt: "请用中文写；\n方法一节要画出数据流。",
};

async function createNote(title: string, body: string): Promise<{ id: string }> {
  const res = await fetch(`${base}/api/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, body, template: null }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { id: string };
}

async function generate(payload: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/ai/template`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** 数据目录里除索引库以外的所有文件（笔记、templates.json、历史）：生成模板不该动它们 */
function snapshotDisk(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!entry.name.startsWith("index.db") && entry.name !== "config.json") out.set(full, fs.readFileSync(full, "utf8"));
    }
  };
  walk(tmp);
  return out;
}

test("一句话描述：模型回的模板过校验后返回，多余字段丢掉；不写盘", async () => {
  reply = `好的：\n\`\`\`json\n${JSON.stringify({ ...GOOD, note: "多余" })}\n\`\`\``;
  requests.length = 0;
  const before = snapshotDisk();
  const { status, body } = await generate({ from: "describe", description: "论文阅读笔记，要能记方法和实验" });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.template, GOOD);
  assert.deepEqual(body.truncated, []);
  assert.equal(typeof body.callId, "number");
  assert.match(requests[0].messages[1].content, /想要的笔记模板：论文阅读笔记，要能记方法和实验/);
  assert.equal(fs.existsSync(path.join(tmp, "templates.json")), false, "不该写出 templates.json");
  assert.deepEqual(snapshotDisk(), before);
});

test("从笔记归纳：发给模型的是去掉文件头和提示注释的正文；太长的截断并告诉前端；不写盘", async () => {
  const a = await createNote("归纳甲", "## 背景\n<!-- 不该发给模型的提示 -->\n\n甲的正文");
  const b = await createNote("归纳乙", `## 背景\n\n${"长".repeat(7000)}`);
  reply = JSON.stringify(GOOD);
  requests.length = 0;
  const before = snapshotDisk();
  const { status, body } = await generate({ from: "notes", ids: [a.id, b.id, a.id], note: "偏重踩坑" });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.truncated, ["归纳乙"]);
  const sent = requests[0].messages[1].content;
  assert.match(sent, /下面是 2 篇笔记/, "重复的 id 只算一次");
  assert.match(sent, /### 笔记 1：归纳甲\n\n## 背景\n\n\n甲的正文|### 笔记 1：归纳甲\n\n## 背景\n+甲的正文/);
  assert.equal(sent.includes("不该发给模型的提示"), false, "提示注释不发");
  assert.equal(sent.includes("id:"), false, "文件头不发");
  assert.match(sent, /### 笔记 2：归纳乙（正文太长，已截断）/);
  // 第二篇正文（含「## 背景」）截到 6000 字
  const second = sent.split("（正文太长，已截断）\n\n")[1].split("\n\n补充说明")[0];
  assert.equal([...second].length, 6000);
  assert.match(sent, /补充说明：偏重踩坑/);
  assert.deepEqual(snapshotDisk(), before);
});

test("和已有模板重名：自动加「 2」", async () => {
  reply = JSON.stringify({ ...GOOD, name: "实现详情" });
  const { status, body } = await generate({ from: "describe", description: "实现笔记" });
  assert.equal(status, 200);
  assert.equal((body.template as { name: string }).name, "实现详情 2");
});

test("改写专属提示词：只换 prompt", async () => {
  reply = '{"prompt": "实验一节列出数据集和指标；\\n结论区分作者声称的和实验证明的。"}';
  requests.length = 0;
  const { status, body } = await generate({ from: "prompt", template: GOOD });
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.template, { ...GOOD, prompt: "实验一节列出数据集和指标；\n结论区分作者声称的和实验证明的。" });
  assert.match(requests[0].messages[1].content, /## 方法\n<!-- 怎么做的 -->/);
});

test("模型回了坏 JSON / 不合格的模板：422，不写盘", async () => {
  const before = snapshotDisk();
  for (const bad of [
    "我建议分成问题、方法、实验三节",
    JSON.stringify({ name: "论文", sections: [] }),
    JSON.stringify({ name: "论文", sections: [{ title: "其他", hint: "" }] }),
    JSON.stringify({ name: "论文", sections: [{ title: "问题", hint: "<!-- 坏 -->" }] }),
  ]) {
    reply = bad;
    const { status, body } = await generate({ from: "describe", description: "论文" });
    assert.equal(status, 422, bad);
    assert.equal(body.code, "TEMPLATE_INVALID");
    assert.match(String(body.error), /什么都没保存/);
  }
  assert.deepEqual(snapshotDisk(), before);
});

test("参数不对：400；笔记不存在：404；模型没回：502", async () => {
  reply = JSON.stringify(GOOD);
  for (const payload of [
    {},
    { from: "notes", ids: [] },
    { from: "notes", ids: ["a", "b", "c", "d", "e", "f"] },
    { from: "describe", description: "  " },
    { from: "describe", description: "字".repeat(501) },
    { from: "prompt", template: { name: "x", sections: [] } },
  ]) {
    const { status } = await generate(payload);
    assert.equal(status, 400, JSON.stringify(payload).slice(0, 60));
  }
  const missing = await generate({ from: "notes", ids: ["nope0000"] });
  assert.equal(missing.status, 404);

  reply = "";
  const blank = await generate({ from: "describe", description: "论文" });
  assert.equal(blank.status, 502);
  assert.equal(blank.body.code, "AI_EMPTY");
});

test("没配置 AI：503 提示先去设置", async () => {
  const key = process.env.STUDY_AI_KEY;
  const configPath = path.join(tmp, "config.json");
  const saved = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;
  delete process.env.STUDY_AI_KEY;
  fs.writeFileSync(configPath, JSON.stringify({ model: "m" }));
  try {
    const { status, body } = await generate({ from: "describe", description: "论文" });
    assert.equal(status, 503);
    assert.equal(body.code, "AI_UNCONFIGURED");
  } finally {
    process.env.STUDY_AI_KEY = key;
    if (saved === null) fs.rmSync(configPath, { force: true });
    else fs.writeFileSync(configPath, saved);
  }
});

test("模板带专属提示词能保存、读回；空的不写进文件；太长 400", async () => {
  const current = (await (await fetch(`${base}/api/templates`)).json()) as { version: number; templates: unknown[] };
  const put = (templates: unknown[], version: number) =>
    fetch(`${base}/api/templates`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version, templates }),
    });
  const res = await put([...current.templates, GOOD, { name: "空提示", sections: [{ title: "甲", hint: "" }], prompt: "  " }], current.version);
  assert.equal(res.status, 200);
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, "templates.json"), "utf8")) as { version: number; templates: Array<Record<string, unknown>> };
  assert.equal(saved.templates.find((item) => item.name === "论文阅读")?.prompt, GOOD.prompt);
  assert.equal("prompt" in (saved.templates.find((item) => item.name === "空提示") ?? {}), false);
  const back = (await (await fetch(`${base}/api/templates`)).json()) as { templates: Array<{ name: string; prompt?: string }> };
  assert.equal(back.templates.find((item) => item.name === "论文阅读")?.prompt, GOOD.prompt);

  const tooLong = await put([{ ...GOOD, prompt: "字".repeat(2001) }], saved.version);
  assert.equal(tooLong.status, 400);
});
