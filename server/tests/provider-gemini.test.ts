import { test } from "node:test";
import assert from "node:assert/strict";
import { streamGeminiTurn } from "../providers/gemini.ts";

function sseResponse(payloads: Array<Record<string, unknown>>): Response {
  const body = `${payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join("")}`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

const BASE = { baseUrl: "https://gemini.test/v1beta", apiKey: "g-key", model: "gemini-2.5-pro" };

test("gemini 用 alt=sse 且把工具声明放 functionDeclarations", async () => {
  let captured: { url: string; body: Record<string, unknown> } | null = null;
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    captured = { url: String(input), body: JSON.parse(String(init.body)) };
    return sseResponse([{ candidates: [{ content: { parts: [{ text: "好" }] } }] }]);
  }) as typeof fetch;

  await collect(
    streamGeminiTurn(
      {
        ...BASE,
        system: "你是助手",
        messages: [{ role: "user", content: "你好" }],
        tools: [{ name: "search_notes", description: "搜", parameters: { type: "object", properties: {} } }],
      },
      fetchImpl,
    ),
  );

  const { url, body } = captured!;
  assert.ok(url.includes(":streamGenerateContent"));
  assert.ok(url.includes("alt=sse"));
  assert.ok(!url.includes("g-key"), "key 不应出现在 URL 里（走 header）");
  const tools = body.tools as Array<{ functionDeclarations: Array<{ name: string }> }>;
  assert.equal(tools[0].functionDeclarations[0].name, "search_notes");
  const sys = body.systemInstruction as { parts: Array<{ text: string }> };
  assert.equal(sys.parts[0].text, "你是助手");
});

test("gemini 的 functionCall 造出 name#n 的 id 并保留 thoughtSignature", async () => {
  const fetchImpl = (async () =>
    sseResponse([
      {
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: "search_notes", args: { query: "中间件" }, thoughtSignature: "sig-xyz" } },
              ],
            },
            finishReason: "STOP",
          },
        ],
      },
    ])) as typeof fetch;

  const events = await collect(streamGeminiTurn({ ...BASE, system: "s", messages: [], tools: [] }, fetchImpl));
  const done = events.at(-1) as { type: "done"; turn: { toolCalls: Array<Record<string, unknown>>; finishReason: string } };
  assert.equal(done.turn.finishReason, "tool");
  assert.equal(done.turn.toolCalls[0].id, "search_notes#0");
  assert.equal(done.turn.toolCalls[0].name, "search_notes");
  assert.deepEqual(done.turn.toolCalls[0].args, { query: "中间件" });
  assert.equal(done.turn.toolCalls[0].opaque, "sig-xyz");
});

test("gemini 历史消息里 assistant 的角色是 model", async () => {
  let captured: Record<string, unknown> | null = null;
  const fetchImpl = (async (_input: string | URL | Request, init: RequestInit = {}) => {
    captured = JSON.parse(String(init.body));
    return sseResponse([{ candidates: [{ content: { parts: [{ text: "ok" }] } }] }]);
  }) as typeof fetch;

  await collect(
    streamGeminiTurn(
      {
        ...BASE,
        system: "s",
        messages: [
          { role: "user", content: "问" },
          { role: "assistant", content: "答" },
        ],
        tools: [],
      },
      fetchImpl,
    ),
  );

  const contents = (captured as unknown as { contents: Array<{ role: string }> }).contents;
  assert.equal(contents.at(-1)!.role, "model");
});

test("gemini 的 functionResponse 包成 {name, response}", async () => {
  let captured: Record<string, unknown> | null = null;
  const fetchImpl = (async (_input: string | URL | Request, init: RequestInit = {}) => {
    captured = JSON.parse(String(init.body));
    return sseResponse([{ candidates: [{ content: { parts: [{ text: "ok" }] } }] }]);
  }) as typeof fetch;

  await collect(
    streamGeminiTurn(
      {
        ...BASE,
        system: "s",
        messages: [
          { role: "user", content: "读" },
          { role: "assistant", content: "", toolCalls: [{ id: "read_note#0", name: "read_note", args: { path: "a.md" } }] },
          { role: "tool", callId: "read_note#0", name: "read_note", content: '{"body":"正文"}' },
        ],
        tools: [],
      },
      fetchImpl,
    ),
  );

  const contents = (captured as unknown as { contents: Array<{ parts: Array<Record<string, unknown>> }> }).contents;
  const part = contents.at(-1)!.parts.find((p) => "functionResponse" in p) as {
    functionResponse: { name: string; response: unknown };
  };
  assert.equal(part.functionResponse.name, "read_note");
  assert.ok(JSON.stringify(part.functionResponse.response).includes("正文"));
});

test("回传历史时 thoughtSignature 放在 part 顶层（不是塞进 functionCall）", async () => {
  let captured: Record<string, unknown> | null = null;
  const fetchImpl = (async (_input: string | URL | Request, init: RequestInit = {}) => {
    captured = JSON.parse(String(init.body));
    return sseResponse([{ candidates: [{ content: { parts: [{ text: "ok" }] } }] }]);
  }) as typeof fetch;

  await collect(
    streamGeminiTurn(
      {
        ...BASE,
        system: "s",
        messages: [
          { role: "user", content: "搜一下中间件" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "search_notes#0", name: "search_notes", args: { query: "中间件" }, opaque: "sig-xyz" }],
          },
          { role: "tool", callId: "search_notes#0", name: "search_notes", content: '{"hits":[]}' },
        ],
        tools: [],
      },
      fetchImpl,
    ),
  );

  const contents = (captured as unknown as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> }).contents;
  const model = contents.find((entry) => entry.role === "model");
  assert.ok(model);
  const callPart = model!.parts.find((part) => "functionCall" in part)!;
  assert.equal(callPart.thoughtSignature, "sig-xyz");
  const fn = callPart.functionCall as Record<string, unknown>;
  assert.equal("thoughtSignature" in fn, false, "签名不该出现在 functionCall 内部");
});
