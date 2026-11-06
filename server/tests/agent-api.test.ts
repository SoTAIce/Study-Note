import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createApp } from "../app.ts";
import { createApi } from "../api.ts";
import { saveProviders } from "../providers/index.ts";
import { createChat, getChat } from "../agent-chats.ts";
import { NoteStore } from "../store.ts";
import { Indexer } from "../indexer.ts";
import { openDb } from "../db.ts";
import type { ProviderEvent, StreamRequest } from "../providers/types.ts";

type Harness = {
  base: string;
  dataDir: string;
  notesRoot: string;
  store: NoteStore;
  close: () => Promise<void>;
};

const SCRIPT_TEXT: ProviderEvent[] = [
  { type: "text", delta: "好的，我先看看" },
  { type: "done", turn: { text: "好的，我先看看", toolCalls: [], finishReason: "stop" } },
];

const SCRIPT_PLAN: ProviderEvent[] = [
  { type: "text", delta: "整理成一篇索引" },
  {
    type: "done",
    turn: {
      text: "整理成一篇索引",
      toolCalls: [
        {
          id: "call_plan",
          name: "propose_plan",
          args: {
            summary: "新建一篇索引",
            ops: [{ kind: "create", path: "backend-go/00-索引.md", title: "索引", body: "# 索引" }],
          },
        },
      ],
      finishReason: "tool",
    },
  },
];

async function startHarness(opts: { configured: boolean; script?: ProviderEvent[] }): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "study-agent-api-"));
  const notesRoot = path.join(dataDir, "notes");
  const distDir = path.join(dataDir, "dist");
  fs.mkdirSync(notesRoot, { recursive: true });
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, "index.html"), "<html></html>", "utf8");

  const store = new NoteStore({
    notesRoot,
    historyDir: path.join(dataDir, ".history"),
    trashDir: path.join(dataDir, ".trash"),
  });
  const db = openDb(path.join(dataDir, "index.db"));
  const indexer = new Indexer({ db, store });
  indexer.reindexAll();

  if (opts.configured) {
    saveProviders(dataDir, {
      activeId: "p1",
      items: [
        {
          id: "p1",
          kind: "openai",
          label: "测试",
          baseUrl: "https://api.test/v1",
          apiKey: "sk-secret-abcdef",
          models: ["m1"],
          defaultModel: "m1",
        },
      ],
    });
  }

  const script = opts.script ?? SCRIPT_TEXT;
  const agentStream = (async function* (_runtime: unknown, _req: StreamRequest): AsyncGenerator<ProviderEvent> {
    for (const event of script) yield event;
  }) as unknown as never;

  const api = createApi({ store, indexer, db, dataDir, agentStream });
  const app = createApp({ dataDir, notesRoot, distDir, api });
  const server = http.createServer((req, res) => {
    void app(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    base: `http://127.0.0.1:${port}`,
    dataDir,
    notesRoot,
    store,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        db.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function readSse(res: Response): Promise<string> {
  const text = await res.text();
  return text;
}

test("GET /api/agent/providers 返回掩码，不含明文 key", async () => {
  const h = await startHarness({ configured: true });
  try {
    const res = await fetch(`${h.base}/api/agent/providers`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes("sk-secret-abcdef"));
    assert.ok(body.items.some((item) => typeof item.apiKeyMasked === "string"));
  } finally {
    await h.close();
  }
});

test("POST /api/agent/chats 后 GET 列表能看到它", async () => {
  const h = await startHarness({ configured: true });
  try {
    const created = await fetch(`${h.base}/api/agent/chats`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(created.status, 201);
    const chat = (await created.json()) as { id: string };
    const listed = (await (await fetch(`${h.base}/api/agent/chats`)).json()) as { items: Array<{ id: string }> };
    assert.ok(listed.items.some((item) => item.id === chat.id));
  } finally {
    await h.close();
  }
});

test("发消息返回 SSE：text→done，且 content-type 正确", async () => {
  const h = await startHarness({ configured: true });
  try {
    const chat = createChat(h.dataDir, { providerId: "p1", model: "m1" });
    const res = await fetch(`${h.base}/api/agent/chats/${chat.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "你好" }),
    });
    assert.equal(res.status, 200);
    assert.ok(String(res.headers.get("content-type")).includes("text/event-stream"));
    const text = await readSse(res);
    assert.ok(text.includes("event: text"));
    assert.ok(text.includes("event: done"));
  } finally {
    await h.close();
  }
});

test("plan 事件带 messageId，执行后笔记落盘，undo 还原", async () => {
  const h = await startHarness({ configured: true, script: SCRIPT_PLAN });
  try {
    const chat = createChat(h.dataDir, { providerId: "p1", model: "m1" });
    const res = await fetch(`${h.base}/api/agent/chats/${chat.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "整理成索引" }),
    });
    const text = await readSse(res);
    assert.ok(text.includes("event: plan"));
    const planLine = text
      .split("\n\n")
      .find((block) => block.startsWith("event: plan"))!;
    const payload = JSON.parse(planLine.split("data: ")[1]) as { messageId: string; plan: { id: string } };
    assert.ok(payload.messageId.startsWith("m_"));

    const executed = await fetch(`${h.base}/api/agent/plans/${payload.plan.id}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(executed.status, 200);
    const execBody = (await executed.json()) as { results: Array<{ status: string }> };
    assert.equal(execBody.results[0].status, "ok");
    assert.ok(fs.existsSync(path.join(h.notesRoot, "backend-go", "00-索引.md")));

    const undone = await fetch(`${h.base}/api/agent/plans/${payload.plan.id}/undo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(undone.status, 200);
    assert.equal(fs.existsSync(path.join(h.notesRoot, "backend-go", "00-索引.md")), false);
    assert.equal(getChat(h.dataDir, chat.id).plans[0].status, "undone");
  } finally {
    await h.close();
  }
});

test("未配置服务商时发消息返回 400 且 code=NO_PROVIDER", async () => {
  const h = await startHarness({ configured: false });
  try {
    const chat = createChat(h.dataDir, { providerId: "deepseek", model: "" });
    const res = await fetch(`${h.base}/api/agent/chats/${chat.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "在吗" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { code: string };
    assert.equal(body.code, "NO_PROVIDER");
  } finally {
    await h.close();
  }
});

test("读目录白名单可读写，默认只有笔记库", async () => {
  const h = await startHarness({ configured: true });
  try {
    const before = (await (await fetch(`${h.base}/api/agent/roots`)).json()) as { readRoots: string[] };
    assert.equal(before.readRoots.length, 1);

    const extra = fs.mkdtempSync(path.join(os.tmpdir(), "study-roots-"));
    try {
      await fetch(`${h.base}/api/agent/roots`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ readRoots: [h.notesRoot, extra] }),
      });
      const after = (await (await fetch(`${h.base}/api/agent/roots`)).json()) as { readRoots: string[] };
      assert.equal(after.readRoots.length, 2);
      assert.ok(after.readRoots.includes(extra));
    } finally {
      fs.rmSync(extra, { recursive: true, force: true });
    }
  } finally {
    await h.close();
  }
});

test("同一个计划不能重复执行，也不能撤销没执行的计划", async () => {
  const h = await startHarness({ configured: true, script: SCRIPT_PLAN });
  try {
    const chat = createChat(h.dataDir, { providerId: "p1", model: "m1" });
    const res = await fetch(`${h.base}/api/agent/chats/${chat.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "整理成索引" }),
    });
    const text = await readSse(res);
    const planLine = text.split("\n\n").find((block) => block.startsWith("event: plan"))!;
    const plan = (JSON.parse(planLine.split("data: ")[1]) as { plan: { id: string } }).plan;

    const earlyUndo = await fetch(`${h.base}/api/agent/plans/${plan.id}/undo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(earlyUndo.status, 400);

    const first = await fetch(`${h.base}/api/agent/plans/${plan.id}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(first.status, 200);

    const second = await fetch(`${h.base}/api/agent/plans/${plan.id}/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(second.status, 400);
  } finally {
    await h.close();
  }
});

test("把 GET 拿到的掩码配置原样 PUT 回去，不会清空已存的 key", async () => {
  const h = await startHarness({ configured: true });
  try {
    const before = (await (await fetch(`${h.base}/api/agent/providers`)).json()) as {
      activeId: string;
      items: Array<Record<string, unknown>>;
    };
    assert.equal(before.items[0].configured, true);

    // 只改模型，key 保持为空（前端拿不到明文，本来就没法回传）
    const items = before.items.map((item) => ({ ...item, defaultModel: "m2", apiKey: "" }));
    const saved = await fetch(`${h.base}/api/agent/providers`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ activeId: before.activeId, items }),
    });
    assert.equal(saved.status, 200);

    const after = (await (await fetch(`${h.base}/api/agent/providers`)).json()) as {
      items: Array<Record<string, unknown>>;
    };
    assert.equal(after.items[0].configured, true, "key 不该被空串冲掉");
    assert.equal(after.items[0].defaultModel, "m2");
    assert.ok(String(after.items[0].apiKeyMasked).length > 0);

    // 既然 key 还在，发消息就不该报 NO_PROVIDER
    const chat = createChat(h.dataDir, { providerId: "p1", model: "m2" });
    const res = await fetch(`${h.base}/api/agent/chats/${chat.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "你好" }),
    });
    assert.equal(res.status, 200);
  } finally {
    await h.close();
  }
});
