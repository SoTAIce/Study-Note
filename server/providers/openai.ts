import {
  AiProviderError,
  httpError,
  readSseData,
  type Msg,
  type ProviderEvent,
  type StreamRequest,
  type ToolCall,
  type ToolSpec,
} from "./types.ts";
import { fetchWithRetry } from "../net.ts";

const TIMEOUT_MS = 180_000;

/** OpenAI 兼容协议：OpenAI、DeepSeek、Kimi、Qwen、Ollama(/v1)、以及多数自建网关。 */
export async function* streamOpenaiTurn(
  opts: { baseUrl: string; apiKey: string; model: string; maxTokens?: number } & StreamRequest,
  fetchImpl: typeof fetch = fetch,
  outerSignal?: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;

  const res = await fetchWithRetry(fetchImpl, `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
    },
    signal,
    body: JSON.stringify({
      model: opts.model,
      messages: toOpenaiMessages(opts.system, opts.messages),
      ...(opts.tools.length > 0 ? { tools: opts.tools.map(toOpenaiTool), tool_choice: "auto" } : {}),
      max_tokens: opts.maxTokens ?? 4096,
      stream: true,
    }),
  });

  if (!res.ok) throw httpError(res.status, await res.text().catch(() => ""));

  let text = "";
  const calls = new Map<number, { id: string; name: string; args: string }>();
  let finishReason: string = "stop";

  for await (const payload of readSseData(res)) {
    const choices = payload.choices;
    if (!Array.isArray(choices) || choices.length === 0) continue;
    const choice = choices[0] as {
      delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
      finish_reason?: string | null;
    };
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      yield { type: "text", delta: delta.content };
    }
    for (const piece of delta.tool_calls ?? []) {
      const index = piece.index ?? 0;
      const current = calls.get(index) ?? { id: "", name: "", args: "" };
      if (piece.id) current.id = piece.id;
      if (piece.function?.name) current.name += piece.function.name;
      if (piece.function?.arguments) current.args += piece.function.arguments;
      calls.set(index, current);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const toolCalls: ToolCall[] = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, call]) => ({
      id: call.id || `call_${index}`,
      name: call.name,
      args: parseArgs(call.args),
    }));

  yield {
    type: "done",
    turn: {
      text,
      toolCalls,
      finishReason: toolCalls.length > 0 || finishReason === "tool_calls" ? "tool" : finishReason === "length" ? "length" : "stop",
    },
  };
}

/** 参数不是合法 JSON 时不要把整个循环弄崩：留给上层回填错误让模型重试。 */
function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __parse_error: raw };
  }
}

function toOpenaiMessages(system: string, messages: Msg[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [{ role: "system", content: system }];
  for (const msg of messages) {
    if (msg.role === "system") {
      out.push({ role: "system", content: msg.content });
    } else if (msg.role === "user") {
      out.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      const entry: Record<string, unknown> = { role: "assistant", content: msg.content };
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        entry.tool_calls = msg.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        }));
      }
      out.push(entry);
    } else {
      out.push({ role: "tool", tool_call_id: msg.callId, content: msg.content });
    }
  }
  return out;
}

function toOpenaiTool(spec: ToolSpec): Record<string, unknown> {
  return {
    type: "function",
    function: { name: spec.name, description: spec.description, parameters: spec.parameters },
  };
}

export { AiProviderError };
