import {
  httpError,
  readSseData,
  type Msg,
  type ProviderEvent,
  type StreamRequest,
  type ToolCall,
} from "./types.ts";
import { fetchWithRetry } from "../net.ts";

const TIMEOUT_MS = 180_000;

type Part = Record<string, unknown>;

/**
 * Gemini generateContent 流式（alt=sse）。
 * 与 OpenAI 的差异：assistant 角色叫 model；系统提示是单独的 systemInstruction；
 * 工具调用没有 id（按 name 配对），而且思考模型会带 thoughtSignature，必须原样回传。
 */
export async function* streamGeminiTurn(
  opts: { baseUrl: string; apiKey: string; model: string; maxTokens?: number } & StreamRequest,
  fetchImpl: typeof fetch = fetch,
  outerSignal?: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;

  const base = opts.baseUrl.replace(/\/+$/, "");
  const url = `${base}/models/${encodeURIComponent(opts.model)}:streamGenerateContent?alt=sse`;

  const res = await fetchWithRetry(fetchImpl, url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // key 放 header，避免出现在 URL/日志里
      "x-goog-api-key": opts.apiKey,
    },
    signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: opts.system }] },
      contents: toGeminiContents(opts.messages),
      ...(opts.tools.length > 0
        ? {
            tools: [
              {
                functionDeclarations: opts.tools.map((spec) => ({
                  name: spec.name,
                  description: spec.description,
                  parameters: spec.parameters,
                })),
              },
            ],
          }
        : {}),
      generationConfig: { maxOutputTokens: opts.maxTokens ?? 4096 },
    }),
  });

  if (!res.ok) throw httpError(res.status, await res.text().catch(() => ""));

  let text = "";
  const toolCalls: ToolCall[] = [];
  let finishReason = "STOP";

  for await (const payload of readSseData(res)) {
    const candidates = payload.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) continue;
    const candidate = candidates[0] as {
      content?: { parts?: Part[] };
      finishReason?: string;
    };
    if (candidate.finishReason) finishReason = candidate.finishReason;
    for (const part of candidate.content?.parts ?? []) {
      if (typeof part.text === "string" && part.text) {
        text += part.text;
        yield { type: "text", delta: part.text };
        continue;
      }
      const call = part.functionCall as { name?: string; args?: unknown; thoughtSignature?: string } | undefined;
      if (call?.name) {
        const signature = call.thoughtSignature ?? (part.thoughtSignature as string | undefined);
        toolCalls.push({
          // Gemini 不给 id，用「名字#序号」造一个稳定 id，工具结果回传时按它配对
          id: `${call.name}#${toolCalls.length}`,
          name: call.name,
          args: call.args ?? {},
          ...(signature ? { opaque: signature } : {}),
        });
      }
    }
  }

  yield {
    type: "done",
    turn: {
      text,
      toolCalls,
      finishReason: toolCalls.length > 0 ? "tool" : finishReason === "MAX_TOKENS" ? "length" : "stop",
    },
  };
}

/** Gemini 要求 user/model 交替；连续的工具结果要合进同一个 user 消息。 */
function toGeminiContents(messages: Msg[]): Array<{ role: "user" | "model"; parts: Part[] }> {
  const out: Array<{ role: "user" | "model"; parts: Part[] }> = [];

  const push = (role: "user" | "model", parts: Part[]) => {
    if (parts.length === 0) return;
    const last = out.at(-1);
    if (last && last.role === role) last.parts.push(...parts);
    else out.push({ role, parts });
  };

  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (msg.role === "user") {
      push("user", [{ text: msg.content }]);
    } else if (msg.role === "assistant") {
      const parts: Part[] = [];
      if (msg.content) parts.push({ text: msg.content });
      for (const call of msg.toolCalls ?? []) {
        // thoughtSignature 是 Part 的兄弟字段，不是 functionCall 内部的字段：
        // 塞进去会被 proto 当未知字段拒掉，或者被静默丢掉，下一轮直接 400。
        const part: Part = { functionCall: { name: call.name, args: call.args ?? {} } };
        if (call.opaque) part.thoughtSignature = call.opaque;
        parts.push(part);
      }
      push("model", parts);
    } else {
      push("user", [{ functionResponse: { name: msg.name, response: { content: msg.content } } }]);
    }
  }

  return out;
}
