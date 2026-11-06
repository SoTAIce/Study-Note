import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendMessages,
  ChatError,
  createChat,
  deleteChat,
  getChat,
  listChats,
  patchChat,
} from "../agent-chats.ts";

function makeDataDir() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "study-chats-"));
  return { dataDir, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

const INIT = { providerId: "deepseek", model: "deepseek-chat" };

test("新建的会话能被列出且按时间倒序", () => {
  const { dataDir, cleanup } = makeDataDir();
  try {
    const first = createChat(dataDir, INIT, { now: () => new Date("2026-11-01T10:00:00Z") });
    appendMessages(dataDir, first.id, [{ role: "user", content: "第一条" }], {
      now: () => new Date("2026-11-01T10:01:00Z"),
    });
    const second = createChat(dataDir, INIT, { now: () => new Date("2026-11-01T11:00:00Z") });
    appendMessages(dataDir, second.id, [{ role: "user", content: "第二条" }], {
      now: () => new Date("2026-11-01T11:01:00Z"),
    });
    const list = listChats(dataDir);
    assert.equal(list.length, 2);
    assert.equal(list[0].id, second.id);
  } finally {
    cleanup();
  }
});

test("消息追加后能读回且顺序不变", () => {
  const { dataDir, cleanup } = makeDataDir();
  try {
    const chat = createChat(dataDir, INIT);
    appendMessages(dataDir, chat.id, [
      { role: "user", content: "问" },
      { role: "assistant", content: "答" },
    ]);
    const reloaded = getChat(dataDir, chat.id);
    assert.deepEqual(
      reloaded.messages.map((m) => m.role),
      ["user", "assistant"],
    );
  } finally {
    cleanup();
  }
});

test("首条用户消息生成标题（不超过 24 字）", () => {
  const { dataDir, cleanup } = makeDataDir();
  try {
    const chat = createChat(dataDir, INIT);
    appendMessages(dataDir, chat.id, [{ role: "user", content: "把 backend-go 整理成一篇索引，顺便补上错误处理那一节" }]);
    const reloaded = getChat(dataDir, chat.id);
    assert.ok(reloaded.title.startsWith("把 backend-go"));
    assert.ok(reloaded.title.length <= 24);
  } finally {
    cleanup();
  }
});

test("opaque 字段能落盘并读回", () => {
  const { dataDir, cleanup } = makeDataDir();
  try {
    const chat = createChat(dataDir, INIT);
    appendMessages(dataDir, chat.id, [
      { role: "assistant", content: "想好了", opaque: { anthropicThinking: [{ type: "thinking", thinking: "..." }] } },
    ]);
    const reloaded = getChat(dataDir, chat.id);
    const msg = reloaded.messages[0] as { opaque?: unknown };
    assert.ok(JSON.stringify(msg.opaque).includes("anthropicThinking"));
  } finally {
    cleanup();
  }
});

test("删除后再读抛 NOT_FOUND", () => {
  const { dataDir, cleanup } = makeDataDir();
  try {
    const chat = createChat(dataDir, INIT);
    deleteChat(dataDir, chat.id);
    assert.throws(
      () => getChat(dataDir, chat.id),
      (err: unknown) => (err as ChatError).code === "NOT_FOUND",
    );
  } finally {
    cleanup();
  }
});

test("会话 id 不能用于路径穿越", () => {
  const { dataDir, cleanup } = makeDataDir();
  try {
    assert.throws(() => getChat(dataDir, "../config"));
    assert.throws(() => getChat(dataDir, "..\\config"));
    assert.throws(() => getChat(dataDir, "a/b"));
  } finally {
    cleanup();
  }
});

test("改名与换模型", () => {
  const { dataDir, cleanup } = makeDataDir();
  try {
    const chat = createChat(dataDir, INIT);
    patchChat(dataDir, chat.id, { title: "新标题", model: "deepseek-reasoner" });
    const reloaded = getChat(dataDir, chat.id);
    assert.equal(reloaded.title, "新标题");
    assert.equal(reloaded.model, "deepseek-reasoner");
  } finally {
    cleanup();
  }
});

test("消息超上限被截断时，不会从 assistant/tool 中间切开", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "study-chat-trim-"));
  try {
    const chat = createChat(dir, { providerId: "p1", model: "m1" });
    const bulk = [];
    for (let i = 0; i < 130; i += 1) {
      bulk.push({ role: "user" as const, content: `第 ${i} 问` });
      bulk.push({
        role: "assistant" as const,
        content: "",
        toolCalls: [{ id: `call_${i}`, name: "list_notes", args: {} }],
      });
      bulk.push({ role: "tool" as const, callId: `call_${i}`, name: "list_notes", content: "[]" });
    }
    // 故意凑成"从 assistant 中间切"的长度，验证截断会挪到最近的用户消息
    appendMessages(dir, chat.id, [{ role: "user", content: "开场" }, ...bulk, { role: "user", content: "收尾" }] as never);
    const stored = getChat(dir, chat.id);
    assert.ok(stored.messages.length <= 130);
    const afterSystem = stored.messages.filter((msg) => msg.role !== "system");
    assert.equal(afterSystem[0].role, "user");
    // 每条 tool 消息前面一定紧跟着带 callId 的 assistant
    for (let i = 0; i < afterSystem.length; i += 1) {
      if (afterSystem[i].role !== "tool") continue;
      const prev = afterSystem[i - 1];
      assert.equal(prev?.role, "assistant");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
