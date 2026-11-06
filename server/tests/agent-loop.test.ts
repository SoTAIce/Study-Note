import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTurn, type AgentEvent } from "../agent.ts";
import { appendMessages, createChat, getChat } from "../agent-chats.ts";
import { createTools } from "../agent-tools.ts";
import { NoteStore } from "../store.ts";
import { Indexer } from "../indexer.ts";
import { openDb } from "../db.ts";
import type { Msg, ProviderEvent, ProviderRuntime, StreamRequest } from "../providers/types.ts";

type Script = (req: StreamRequest, call: number) => ProviderEvent[];

function makeCtx(script: Script) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "study-loop-"));
  const notesRoot = path.join(dataDir, "notes");
  fs.mkdirSync(notesRoot, { recursive: true });
  const store = new NoteStore({
    notesRoot,
    historyDir: path.join(dataDir, ".history"),
    trashDir: path.join(dataDir, ".trash"),
  });
  const db = openDb(path.join(dataDir, "index.db"));
  const indexer = new Indexer({ db, store });
  const tools = createTools({ db, store, notesRoot, readRoots: [notesRoot] });
  const seen: StreamRequest[] = [];

  const streamTurn = (async function* (
    _runtime: unknown,
    req: StreamRequest,
  ): AsyncGenerator<ProviderEvent> {
    seen.push(req);
    const events = script(req, seen.length);
    for (const event of events) yield event;
  }) as unknown as (
    runtime: unknown,
    req: StreamRequest,
    fetchImpl?: typeof fetch,
    signal?: AbortSignal,
  ) => AsyncGenerator<ProviderEvent>;

  return {
    dataDir,
    notesRoot,
    store,
    db,
    indexer,
    tools,
    seen,
    streamTurn,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const RUNTIME: ProviderRuntime = { kind: "openai", baseUrl: "https://x.test/v1", apiKey: "k", model: "m" };

function turnOf(text: string, toolCalls: Array<{ id: string; name: string; args: unknown }> = []): ProviderEvent {
  return {
    type: "done",
    turn: {
      text,
      toolCalls,
      finishReason: toolCalls.length > 0 ? "tool" : "stop",
    },
  };
}

test("一次纯文本回答：事件序列 text→done 且消息落盘", async () => {
  const ctx = makeCtx(() => [{ type: "text", delta: "你好" }, turnOf("你好")]);
  try {
    const chat = createChat(ctx.dataDir, { providerId: "deepseek", model: "deepseek-chat" });
    const events: AgentEvent[] = [];
    await runTurn(
      {
        dataDir: ctx.dataDir,
        chatId: chat.id,
        text: "打个招呼",
        tools: ctx.tools,
        runtime: RUNTIME,
        streamTurn: ctx.streamTurn,
      },
      (event) => events.push(event),
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ["text", "done"],
    );
    const reloaded = getChat(ctx.dataDir, chat.id);
    assert.deepEqual(
      reloaded.messages.map((m) => m.role),
      ["user", "assistant"],
    );
    assert.equal((reloaded.messages[1] as { content: string }).content, "你好");
  } finally {
    ctx.cleanup();
  }
});

test("系统提示词含「只能通过 propose_plan 改动」", async () => {
  const ctx = makeCtx(() => [turnOf("好")]);
  try {
    const chat = createChat(ctx.dataDir, { providerId: "deepseek", model: "deepseek-chat" });
    await runTurn(
      { dataDir: ctx.dataDir, chatId: chat.id, text: "hi", tools: ctx.tools, runtime: RUNTIME, streamTurn: ctx.streamTurn },
      () => {},
    );
    const system = ctx.seen[0].system;
    assert.ok(system.includes("propose_plan"));
    assert.ok(system.includes("20"));
  } finally {
    ctx.cleanup();
  }
});

test("先搜后答：事件序列 text→step→text→done，第二轮带上 role:tool", async () => {
  const ctx = makeCtx((_req, call) => {
    if (call === 1) {
      return [
        { type: "text", delta: "我搜一下" },
        turnOf("我搜一下", [{ id: "call_1", name: "list_notes", args: {} }]),
      ];
    }
    return [{ type: "text", delta: "库里有 0 篇" }, turnOf("库里有 0 篇")];
  });
  try {
    const chat = createChat(ctx.dataDir, { providerId: "deepseek", model: "deepseek-chat" });
    const events: AgentEvent[] = [];
    await runTurn(
      { dataDir: ctx.dataDir, chatId: chat.id, text: "库里有什么", tools: ctx.tools, runtime: RUNTIME, streamTurn: ctx.streamTurn },
      (event) => events.push(event),
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ["text", "step", "text", "done"],
    );
    const step = events.find((event) => event.type === "step") as { status: string; name: string };
    assert.equal(step.name, "list_notes");
    assert.equal(step.status, "ok");
    const second = ctx.seen[1].messages;
    assert.ok(second.some((msg: Msg) => msg.role === "tool"));
  } finally {
    ctx.cleanup();
  }
});

test("propose_plan 终止循环并推 plan 事件", async () => {
  const ctx = makeCtx((_req, call) => {
    if (call === 1) {
      return [
        turnOf("", [
          {
            id: "call_1",
            name: "propose_plan",
            args: { summary: "新建一篇", ops: [{ kind: "create", title: "新篇", body: "# 新篇" }] },
          },
        ]),
      ];
    }
    return [turnOf("不该到这里")];
  });
  try {
    const chat = createChat(ctx.dataDir, { providerId: "deepseek", model: "deepseek-chat" });
    const events: AgentEvent[] = [];
    await runTurn(
      { dataDir: ctx.dataDir, chatId: chat.id, text: "建一篇", tools: ctx.tools, runtime: RUNTIME, streamTurn: ctx.streamTurn },
      (event) => events.push(event),
    );
    assert.equal(events.at(-1)!.type, "plan");
    assert.equal(ctx.seen.length, 1, "出计划后不应再调用模型");
    const planEvent = events.at(-1) as { messageId: string; plan: { ops: unknown[] } };
    assert.equal(planEvent.plan.ops.length, 1);
    assert.ok(planEvent.messageId.length > 0);
    const reloaded = getChat(ctx.dataDir, chat.id);
    assert.equal(reloaded.plans.length, 1);
    assert.equal(reloaded.plans[0].status, "pending");
  } finally {
    ctx.cleanup();
  }
});

test("工具参数是坏 JSON 时回填错误给模型而不崩", async () => {
  const ctx = makeCtx((_req, call) => {
    if (call === 1) {
      return [turnOf("", [{ id: "call_1", name: "read_note", args: { __parse_error: '{"path":' } }])];
    }
    return [turnOf("好吧")];
  });
  try {
    const chat = createChat(ctx.dataDir, { providerId: "deepseek", model: "deepseek-chat" });
    const events: AgentEvent[] = [];
    await runTurn(
      { dataDir: ctx.dataDir, chatId: chat.id, text: "读一下", tools: ctx.tools, runtime: RUNTIME, streamTurn: ctx.streamTurn },
      (event) => events.push(event),
    );
    const step = events.find((event) => event.type === "step") as { status: string };
    assert.equal(step.status, "error");
    const toolMsg = ctx.seen[1].messages.find((msg: Msg) => msg.role === "tool") as { content: string };
    assert.ok(toolMsg.content.includes("参数"));
    assert.equal(events.at(-1)!.type, "done");
  } finally {
    ctx.cleanup();
  }
});

test("12 次工具调用上限被触发", async () => {
  const ctx = makeCtx(() => [turnOf("继续", [{ id: `call_${Math.random()}`, name: "list_notes", args: {} }])]);
  try {
    const chat = createChat(ctx.dataDir, { providerId: "deepseek", model: "deepseek-chat" });
    const events: AgentEvent[] = [];
    await runTurn(
      { dataDir: ctx.dataDir, chatId: chat.id, text: "一直查", tools: ctx.tools, runtime: RUNTIME, streamTurn: ctx.streamTurn },
      (event) => events.push(event),
    );
    assert.ok(ctx.seen.length <= 13, `模型最多被调用 13 次，实际 ${ctx.seen.length}`);
    const steps = events.filter((event) => event.type === "step").length;
    assert.ok(steps <= 12);
    assert.equal(events.at(-1)!.type, "done");
  } finally {
    ctx.cleanup();
  }
});

test("中途 abort：已产出的文本仍保存，末尾是 cancelled", async () => {
  const controller = new AbortController();
  const dataDirHolder: { onEvent?: (event: AgentEvent) => void } = {};
  const ctx = makeCtx(() => []);
  try {
    const chat = createChat(ctx.dataDir, { providerId: "deepseek", model: "deepseek-chat" });
    const streamTurn = (async function* (): AsyncGenerator<ProviderEvent> {
      yield { type: "text", delta: "写到一半" };
      controller.abort();
      yield { type: "text", delta: "不该出现" };
      throw Object.assign(new Error("aborted"), { code: "AI_CANCELLED" });
    }) as unknown as (runtime: unknown, req: StreamRequest, f?: typeof fetch, s?: AbortSignal) => AsyncGenerator<ProviderEvent>;

    const events: AgentEvent[] = [];
    dataDirHolder.onEvent = (event) => events.push(event);
    await runTurn(
      {
        dataDir: ctx.dataDir,
        chatId: chat.id,
        text: "写一篇",
        tools: ctx.tools,
        runtime: RUNTIME,
        streamTurn,
        signal: controller.signal,
      },
      (event) => events.push(event),
    );
    assert.equal(events.at(-1)!.type, "cancelled");
    const reloaded = getChat(ctx.dataDir, chat.id);
    const assistant = reloaded.messages.find((msg) => msg.role === "assistant") as { content: string };
    assert.ok(assistant.content.includes("写到一半"));
  } finally {
    ctx.cleanup();
  }
});

test("上下文压缩按整轮，不切断 tool_call 配对", async () => {
  const ctx = makeCtx(() => [turnOf("查", [{ id: `c${Math.random()}`, name: "list_notes", args: {} }])]);
  try {
    const chat = createChat(ctx.dataDir, { providerId: "deepseek", model: "deepseek-chat" });
    // 预置 6 轮完整工具往返
    const preload: Msg[] = [{ role: "user", content: "老问题" }];
    for (let i = 0; i < 6; i += 1) {
      preload.push({ role: "assistant", content: "", toolCalls: [{ id: `old_${i}`, name: "list_notes", args: {} }] });
      preload.push({ role: "tool", callId: `old_${i}`, name: "list_notes", content: "[]" });
    }
    appendMessages(ctx.dataDir, chat.id, preload);

    await runTurn(
      { dataDir: ctx.dataDir, chatId: chat.id, text: "再查", tools: ctx.tools, runtime: RUNTIME, streamTurn: ctx.streamTurn },
      () => {},
    );

    const sent = ctx.seen[0].messages;
    // 所有 tool 消息都必须能找到对应的 assistant tool_call（配对不破）
    const callIds = new Set(
      sent.flatMap((msg) => (msg.role === "assistant" ? (msg.toolCalls ?? []).map((call) => call.id) : [])),
    );
    for (const msg of sent) {
      if (msg.role === "tool") assert.ok(callIds.has(msg.callId), `孤立工具结果：${msg.callId}`);
    }
    assert.ok(sent.some((msg) => msg.role === "user" && msg.content === "老问题"), "用户消息不能被压缩掉");
    assert.ok(
      sent.some((msg) => msg.role === "system" && msg.content.includes("省略")),
      "应出现整轮摘要占位",
    );
  } finally {
    ctx.cleanup();
  }
});

test("第一轮就被中断时不留下空 assistant 消息（否则下次请求会被拒）", async () => {
  let round = 0;
  const ctx = makeCtx(() => {
    round += 1;
    return [turnOf("")];
  });
  try {
    const chat = createChat(ctx.dataDir, { providerId: "p1", model: "m1" });
    const controller = new AbortController();
    // 模拟「客户端断开」：流刚开就被 abort，一帧正文都没有
    const streamTurn = (async function* () {
      controller.abort();
      throw Object.assign(new Error("已取消"), { code: "AI_CANCELLED" });
    }) as unknown as typeof ctx.streamTurn;

    const events: AgentEvent[] = [];
    await runTurn(
      {
        dataDir: ctx.dataDir,
        chatId: chat.id,
        text: "你好",
        tools: ctx.tools,
        runtime: RUNTIME,
        signal: controller.signal,
        streamTurn,
      },
      (event) => events.push(event),
    );
    assert.ok(events.some((event) => event.type === "cancelled"));
    const stored = getChat(ctx.dataDir, chat.id);
    assert.deepEqual(
      stored.messages.map((msg) => msg.role),
      ["user"],
    );
  } finally {
    ctx.cleanup();
  }
});
