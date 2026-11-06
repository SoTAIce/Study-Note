import { test } from "node:test";
import assert from "node:assert/strict";
import { streamAnthropicTurn } from "../providers/anthropic.ts";

function sseResponse(payloads: Array<Record<string, unknown>>): Response {
  const body = `${payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function captureFetch(payloads: Array<Record<string, unknown>>): { fetchImpl: typeof fetch; get: () => Captured } {
  let captured: Captured | null = null;
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    captured = {
      url: String(input),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init.body)),
    };
    return sseResponse(payloads);
  }) as typeof fetch;
  return { fetchImpl, get: () => captured! };
}

const BASE = { baseUrl: "https://api.anthropic.test/v1", apiKey: "sk-ant-1", model: "claude-x" };

test("anthropic 把 system 放顶层并带版本头", async () => {
  const { fetchImpl, get } = captureFetch([
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
  ]);

  await collect(
    streamAnthropicTurn({ ...BASE, system: "你是助手", messages: [{ role: "user", content: "你好" }], tools: [] }, fetchImpl),
  );

  const { url, headers, body } = get();
  assert.equal(url, "https://api.anthropic.test/v1/messages");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["x-api-key"], "sk-ant-1");
  assert.equal(body.system, "你是助手");
  assert.equal(body.max_tokens, 4096);
  const messages = body.messages as Array<{ role: string }>;
  assert.equal(messages.some((m) => m.role === "system"), false);
});

test("anthropic 解析 tool_use，并把 thinking 块透传进 opaque", async () => {
  const { fetchImpl } = captureFetch([
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "先想想" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "read_note" } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"a.md"}' } },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
  ]);

  const events = await collect(
    streamAnthropicTurn({ ...BASE, system: "s", messages: [{ role: "user", content: "看看" }], tools: [] }, fetchImpl),
  );

  const done = events.at(-1) as { type: "done"; turn: { toolCalls: Array<Record<string, unknown>>; finishReason: string; opaque?: unknown } };
  assert.equal(done.type, "done");
  assert.equal(done.turn.finishReason, "tool");
  assert.equal(done.turn.toolCalls[0].id, "tu_1");
  assert.equal(done.turn.toolCalls[0].name, "read_note");
  assert.deepEqual(done.turn.toolCalls[0].args, { path: "a.md" });
  assert.ok(JSON.stringify(done.turn.opaque).includes("先想想"));
  assert.ok(JSON.stringify(done.turn.opaque).includes("sig-abc"));
});

test("anthropic 的 tool 结果按 tool_result 形状回传", async () => {
  const { fetchImpl, get } = captureFetch([{ type: "message_delta", delta: { stop_reason: "end_turn" } }]);

  await collect(
    streamAnthropicTurn(
      {
        ...BASE,
        system: "s",
        messages: [
          { role: "user", content: "读一下" },
          { role: "assistant", content: "", toolCalls: [{ id: "tu_1", name: "read_note", args: { path: "a.md" } }] },
          { role: "tool", callId: "tu_1", name: "read_note", content: "正文" },
        ],
        tools: [],
      },
      fetchImpl,
    ),
  );

  const messages = get().body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  const toolMsg = messages.find((m) => m.content.some((c) => c.type === "tool_result"))!;
  assert.ok(toolMsg);
  const block = toolMsg.content.find((c) => c.type === "tool_result")!;
  assert.equal(block.tool_use_id, "tu_1");
  assert.ok(JSON.stringify(block.content).includes("正文"));
});
