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

type Block = Record<string, unknown>;

/**
 * Anthropic Messages API。
 * 三个与 OpenAI 不同、且必须照顾到的点：
 *  - system 是顶层字段，不是一条 message；
 *  - 必须带 anthropic-version 头，max_tokens 必填；
 *  - 工具结果以 tool_result 块回传，且 thinking 块必须原样带回（否则下一轮 400）。
 */
export async function* streamAnthropicTurn(
  opts: { baseUrl: string; apiKey: string; model: string; maxTokens?: number } & StreamRequest,
  fetchImpl: typeof fetch = fetch,
  outerSignal?: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;

  const res = await fetchWithRetry(fetchImpl, `${opts.baseUrl.replace(/\/+$/, "")}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01",
    },
    signal,
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      system: opts.system,
      messages: toAnthropicMessages(opts.messages),
      ...(opts.tools.length > 0
        ? { tools: opts.tools.map((spec) => ({ name: spec.name, description: spec.description, input_schema: spec.parameters })) }
        : {}),
      stream: true,
    }),
  });

  if (!res.ok) throw httpError(res.status, await res.text().catch(() => ""));

  let text = "";
  const calls = new Map<number, { id: string; name: string; args: string }>();
  const thinking: Block[] = [];
  let stopReason = "end_turn";

  for await (const payload of readSseData(res)) {
    const type = payload.type;
    const index = Number(payload.index ?? 0);

    if (type === "content_block_start") {
      const block = payload.content_block as Block | undefined;
      if (!block) continue;
      if (block.type === "tool_use") {
        calls.set(index, { id: String(block.id ?? `tu_${index}`), name: String(block.name ?? ""), args: "" });
      } else if (block.type === "thinking") {
        thinking.push({ type: "thinking", thinking: String(block.thinking ?? ""), signature: String(block.signature ?? "") });
      } else if (block.type === "redacted_thinking") {
        thinking.push(block);
      }
      continue;
    }

    if (type === "content_block_delta") {
      const delta = payload.delta as Block | undefined;
      if (!delta) continue;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        text += delta.text;
        yield { type: "text", delta: delta.text };
      } else if (delta.type === "input_json_delta") {
        const call = calls.get(index);
        if (call) call.args += String(delta.partial_json ?? "");
      } else if (delta.type === "thinking_delta") {
        const last = thinking.at(-1);
        if (last) last.thinking = String(last.thinking ?? "") + String(delta.thinking ?? "");
      } else if (delta.type === "signature_delta") {
        const last = thinking.at(-1);
        if (last) last.signature = String(delta.signature ?? "");
      }
      continue;
    }

    if (type === "message_delta") {
      const delta = payload.delta as { stop_reason?: string } | undefined;
      if (delta?.stop_reason) stopReason = delta.stop_reason;
    }
  }

  const toolCalls: ToolCall[] = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, call]) => ({ id: call.id, name: call.name, args: parseArgs(call.args) }));

  yield {
    type: "done",
    turn: {
      text,
      toolCalls,
      finishReason: toolCalls.length > 0 ? "tool" : stopReason === "max_tokens" ? "length" : "stop",
      ...(thinking.length > 0 ? { opaque: { anthropicThinking: thinking } } : {}),
    },
  };
}

function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __parse_error: raw };
  }
}

/**
 * 转成 Anthropic 的 messages。两个硬性要求：
 *  - 相邻同角色的消息必须合并（Anthropic 要求 user/assistant 交替）；
 *  - 连续多个工具结果要合进同一个 user 消息里。
 */
function toAnthropicMessages(messages: Msg[]): Array<{ role: "user" | "assistant"; content: Block[] }> {
  const out: Array<{ role: "user" | "assistant"; content: Block[] }> = [];

  const push = (role: "user" | "assistant", blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = out.at(-1);
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const msg of messages) {
    if (msg.role === "system") continue;
    if (msg.role === "user") {
      push("user", [{ type: "text", text: msg.content }]);
    } else if (msg.role === "assistant") {
      const blocks: Block[] = [];
      const opaqueThinking = (msg.opaque as { anthropicThinking?: Block[] } | undefined)?.anthropicThinking;
      if (Array.isArray(opaqueThinking)) blocks.push(...opaqueThinking);
      if (msg.content) blocks.push({ type: "text", text: msg.content });
      for (const call of msg.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.args ?? {} });
      }
      push("assistant", blocks);
    } else {
      push("user", [
        { type: "tool_result", tool_use_id: msg.callId, content: [{ type: "text", text: msg.content }] },
      ]);
    }
  }

  return out;
}
