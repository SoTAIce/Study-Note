/** 内部统一的消息/工具格式。适配器只负责把它翻译成各家协议，上层不感知差异。 */

export type ToolCall = {
  id: string;
  name: string;
  args: unknown;
  /** 服务商私有字段（Gemini 的 thoughtSignature、Anthropic 的 thinking block 等），必须原样回传 */
  opaque?: unknown;
};

export type Msg =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[]; opaque?: unknown }
  | { role: "tool"; callId: string; name: string; content: string; opaque?: unknown };

export type Turn = {
  text: string;
  toolCalls: ToolCall[];
  finishReason: "stop" | "tool" | "length";
  /**
   * 整轮级别的私有载荷。Anthropic 的 thinking 块不属于任何一次 tool call，
   * 但下一轮请求必须原样带回去，所以挂在整轮上。
   */
  opaque?: unknown;
};

export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema（object 根） */
  parameters: Record<string, unknown>;
};

export type ProviderKind = "openai" | "anthropic" | "gemini";

export type ProviderConfig = {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  defaultModel: string;
};

export type ProviderEvent = { type: "text"; delta: string } | { type: "done"; turn: Turn };

/** 一次调用所需的运行时参数（从 ProviderConfig 里挑出来，避免适配器读全局配置）。 */
export type ProviderRuntime = {
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
};

export type StreamRequest = {
  system: string;
  messages: Msg[];
  tools: ToolSpec[];
};

export class AiProviderError extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "AiProviderError";
    this.code = code;
    this.status = status;
  }
}

/** 把 HTTP 状态映射成前端能读懂的错误码。 */
export function httpError(status: number, body: string): AiProviderError {
  const tail = body.slice(0, 200);
  if (status === 401 || status === 403) return new AiProviderError("AI_AUTH", `鉴权失败（${status}），检查 key 与服务商`, status);
  if (status === 429) return new AiProviderError("AI_RATE", "被服务商限流（429），稍后再试", status);
  if (status >= 500) return new AiProviderError("AI_HTTP", `服务商错误（${status}）：${tail}`, status);
  return new AiProviderError("AI_HTTP", `请求失败（${status}）：${tail}`, status);
}

/** 有些网关（已知 cline.bot）把 OpenAI 响应多包一层 {success,data}。 */
export function unwrapPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const record = payload as Record<string, unknown>;
  const data = record.data;
  if (record.success !== undefined && data && typeof data === "object") {
    return data as Record<string, unknown>;
  }
  return record;
}

/** 逐行读 SSE，回调每个 data 负载；返回时流已结束。 */
export async function* readSseData(res: Response): AsyncGenerator<Record<string, unknown>> {
  const reader = res.body?.getReader();
  if (!reader) throw new AiProviderError("AI_HTTP", "响应没有 body");
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        yield unwrapPayload(JSON.parse(data));
      } catch {
        // 单个坏包不影响整体
      }
    }
  }
}
