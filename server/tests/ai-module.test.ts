import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AiEmptyError,
  buildMessages,
  loadAiConfig,
  maskConfig,
  normalizeResponse,
  REWRITE_MODES,
  saveAiConfig,
  streamAi,
  type AiConfig,
} from "../ai.ts";

const cfg: AiConfig = {
  baseUrl: "https://example.invalid/api/v1",
  apiKey: "sk-test",
  model: "test-model",
  temperature: 0.4,
  maxTokens: 2048,
};

function sseResponse(chunks: string[]): Response {
  const body = chunks.map((c) => `data: ${c}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("normalizeResponse 兼容标准形状与多包一层", () => {
  const plain = normalizeResponse({ choices: [{ message: { content: "x", reasoning: "r" } }] });
  assert.deepEqual(plain, { content: "x", reasoning: "r" });
  const wrapped = normalizeResponse({ success: true, data: { choices: [{ message: { content: "y" } }] } });
  assert.deepEqual(wrapped, { content: "y", reasoning: null });
});

test("正文为空时抛 AiEmptyError（推理 token 吃光预算的典型症状）", () => {
  assert.throws(
    () => normalizeResponse({ choices: [{ message: { content: "", reasoning: "想了很久" } }] }),
    (err: unknown) => err instanceof AiEmptyError,
  );
});

test("六种动作的 prompt 互不相同且包含关键要求", () => {
  const input = { noteTitle: "位置编码", noteBody: "正文内容", selection: "选中的一句" };
  const modes = ["expand", "summarize", "explain", "quiz", "continue", "ask"] as const;
  const systems = new Set<string>();
  for (const mode of modes) {
    const messages = buildMessages(mode, { ...input, question: "为什么需要它？" });
    assert.equal(messages.length, 2);
    assert.ok(messages[1].content.includes("位置编码"));
    systems.add(messages[0].content);
  }
  assert.equal(systems.size, 6);
  const explain = buildMessages("explain", input);
  assert.ok(explain[0].content.includes("用初学者能懂的方式"));
  assert.ok(explain[1].content.includes("选中的一句"));
});

test("改稿类动作：整篇输出、rewrite 带上要求、有选中就只改选段", () => {
  const input = { noteTitle: "位置编码", noteBody: "第一段\n第二段" };

  const polish = buildMessages("polish", input);
  assert.ok(polish[0].content.includes("润色"));
  assert.ok(polish[1].content.includes("第一段"));
  assert.ok(polish[1].content.includes("待改写的完整正文"));

  const rewrite = buildMessages("rewrite", { ...input, question: "把第二节改成对比表" });
  assert.ok(rewrite[1].content.includes("改写要求：把第二节改成对比表"));
  // 不允许把「所在笔记正文」误导成要输出的整篇
  assert.ok(rewrite[0].content.includes("直接输出改写后的完整正文"));

  const tidy = buildMessages("tidy", { ...input, selection: "只有这一段" });
  assert.ok(tidy[1].content.includes("待改写的内容"));
  assert.ok(tidy[1].content.includes("只有这一段"));
  assert.ok(!tidy[1].content.includes("待改写的完整正文"));

  // 四种改稿动作的 prompt 各不相同
  const systems = new Set(
    (["polish", "shorten", "tidy", "rewrite"] as const).map(
      (mode) => buildMessages(mode, input)[0].content,
    ),
  );
  assert.equal(systems.size, 4);
  assert.ok(REWRITE_MODES.has("polish") && REWRITE_MODES.has("rewrite"));
  assert.ok(!REWRITE_MODES.has("summarize"));
});

test("streamAi 逐块产出增量并跳过 [DONE]", async () => {
  const fetchImpl = (async () =>
    sseResponse([
      JSON.stringify({ choices: [{ delta: { content: "你" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "好" } }] }),
      "[DONE]",
    ])) as unknown as typeof fetch;
  const out: string[] = [];
  for await (const delta of streamAi(cfg, buildMessages("summarize", { noteTitle: "t", noteBody: "b" }), fetchImpl)) {
    out.push(delta);
  }
  assert.deepEqual(out, ["你", "好"]);
});

test("上游 500 且 body 含 empty response content 时抛 AiEmptyError", async () => {
  const fetchImpl = (async () =>
    new Response('{"error":"empty response content","success":false}', {
      status: 500,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  await assert.rejects(async () => {
    for await (const _ of streamAi(cfg, buildMessages("quiz", { noteTitle: "t", noteBody: "b" }), fetchImpl)) {
      // 不应产出任何增量
    }
  }, (err: unknown) => err instanceof AiEmptyError);
});

test("流中途断开时已产出的内容不丢，错误带 partial", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "半" } }] })}\n\n`),
      );
      setTimeout(() => controller.error(new Error("socket hang up")), 5);
    },
  });
  const fetchImpl = (async () =>
    new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;

  const got: string[] = [];
  await assert.rejects(
    async () => {
      for await (const delta of streamAi(cfg, buildMessages("expand", { noteTitle: "t", noteBody: "b" }), fetchImpl)) {
        got.push(delta);
      }
    },
    (err: unknown) => (err as { partial?: string }).partial === "半",
  );
  assert.deepEqual(got, ["半"]);
});

test("配置：保存后可读回，mask 不泄露 key", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-ai-"));
  const saved = saveAiConfig(dataDir, { apiKey: "sk-abcdefghijklmn", model: "m1" });
  assert.equal(saved.apiKey, "sk-abcdefghijklmn");
  const loaded = loadAiConfig(dataDir, {});
  assert.ok(loaded);
  assert.equal(loaded.model, "m1");
  const masked = maskConfig(loaded);
  assert.equal(masked.configured, true);
  assert.equal(masked.apiKeyMasked.includes("abcdefghij"), false);
  assert.ok(masked.apiKeyMasked.startsWith("sk-ab"));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("配置：文件损坏时返回 null 而不是抛错", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sn-ai-bad-"));
  fs.writeFileSync(path.join(dataDir, "config.json"), "{坏 json", "utf8");
  assert.equal(loadAiConfig(dataDir, {}), null);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
