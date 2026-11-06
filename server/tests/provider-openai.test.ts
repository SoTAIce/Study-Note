import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProviders, maskProviders, saveProviders } from "../providers/index.ts";
import { streamOpenaiTurn } from "../providers/openai.ts";

function sseResponse(payloads: string[]): Response {
  const body = `${payloads.map((p) => `data: ${p}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

const TOOL_SPEC = {
  name: "search_notes",
  description: "搜笔记",
  parameters: { type: "object", properties: { query: { type: "string" } } },
};

test("openai 请求体带 tools 且消息按内部格式翻译", async () => {
  const captured: { url: string; body: Record<string, unknown> } = { url: "", body: {} };
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    captured.url = String(input);
    captured.body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return sseResponse(['{"choices":[{"delta":{"content":"好"}}]}']);
  }) as typeof fetch;

  await collect(
    streamOpenaiTurn(
      {
        baseUrl: "https://api.test/v1",
        apiKey: "sk-1",
        model: "m-1",
        system: "你是助手",
        messages: [
          { role: "user", content: "你好" },
          { role: "tool", callId: "call_1", name: "search_notes", content: '{"hits":[]}' },
        ],
        tools: [TOOL_SPEC],
      },
      fetchImpl,
    ),
  );

  const { url, body } = captured;
  assert.equal(url, "https://api.test/v1/chat/completions");
  assert.equal(body.model, "m-1");
  assert.equal(body.stream, true);
  const tools = body.tools as Array<{ type: string; function: { name: string } }>;
  assert.equal(tools[0].type, "function");
  assert.equal(tools[0].function.name, "search_notes");
  const messages = body.messages as Array<{ role: string; content?: string }>;
  assert.equal(messages[0].role, "system");
  assert.equal(messages[0].content === undefined, false);
  const toolMsg = messages.find((m) => m.role === "tool") as unknown as { tool_call_id: string };
  assert.equal(toolMsg.tool_call_id, "call_1");
});

test("解析流式增量与分片 tool_calls", async () => {
  const fetchImpl = (async () =>
    sseResponse([
      '{"choices":[{"delta":{"content":"你好"}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read_note","arguments":"{\\"pa"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.md\\"}"}}]},"finish_reason":"tool_calls"}]}',
    ])) as typeof fetch;

  const events = await collect(
    streamOpenaiTurn(
      { baseUrl: "https://api.test/v1", apiKey: "k", model: "m", system: "s", messages: [], tools: [] },
      fetchImpl,
    ),
  );

  const text = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta);
  assert.deepEqual(text, ["你好"]);
  const done = events.at(-1) as { type: "done"; turn: { toolCalls: Array<Record<string, unknown>>; finishReason: string } };
  assert.equal(done.type, "done");
  assert.equal(done.turn.finishReason, "tool");
  assert.equal(done.turn.toolCalls.length, 1);
  assert.equal(done.turn.toolCalls[0].name, "read_note");
  assert.deepEqual(done.turn.toolCalls[0].args, { path: "a.md" });
});

test("401 映射成可读错误", async () => {
  const fetchImpl = (async () => new Response("bad key", { status: 401 })) as typeof fetch;
  await assert.rejects(
    () =>
      collect(
        streamOpenaiTurn(
          { baseUrl: "https://api.test/v1", apiKey: "k", model: "m", system: "s", messages: [], tools: [] },
          fetchImpl,
        ),
      ),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "AI_AUTH");
      return true;
    },
  );
});

test("网关多包一层 {success,data} 也能解析", async () => {
  const fetchImpl = (async () =>
    sseResponse(['{"success":true,"data":{"choices":[{"delta":{"content":"包了一层"}}]}}'])) as typeof fetch;
  const events = await collect(
    streamOpenaiTurn(
      { baseUrl: "https://api.test/v1", apiKey: "k", model: "m", system: "s", messages: [], tools: [] },
      fetchImpl,
    ),
  );
  const text = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta);
  assert.deepEqual(text, ["包了一层"]);
});

test("配置读写会掩码 apiKey", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "study-providers-"));
  try {
    saveProviders(dataDir, {
      activeId: "p1",
      items: [
        {
          id: "p1",
          kind: "openai",
          label: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "sk-secret-123456",
          models: ["deepseek-chat"],
          defaultModel: "deepseek-chat",
        },
      ],
    });
    const loaded = loadProviders(dataDir);
    assert.equal(loaded.activeId, "p1");
    assert.equal(loaded.items[0].apiKey, "sk-secret-123456");

    const masked = maskProviders(loaded);
    assert.ok(!matched(masked.items[0].apiKeyMasked, "sk-secret-123456"));
    assert.equal("apiKey" in masked.items[0], false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

function matched(haystack: string, needle: string): boolean {
  return haystack.includes(needle);
}
