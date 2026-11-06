import fs from "node:fs";
import path from "node:path";
import { patchConfig, readConfig } from "./config.ts";
import { fetchWithRetry } from "./net.ts";

export type AiMode =
  | "expand"
  | "summarize"
  | "explain"
  | "quiz"
  | "continue"
  | "ask"
  | "polish"
  | "shorten"
  | "tidy"
  | "rewrite";

/** 需要「整篇替换」的动作：产出的是可以直接覆盖正文的完整版本。 */
export const REWRITE_MODES: ReadonlySet<AiMode> = new Set<AiMode>(["polish", "shorten", "tidy", "rewrite"]);

export type AiConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
};

export type ChatMessage = { role: "system" | "user"; content: string };

export const DEFAULT_AI: Omit<AiConfig, "apiKey"> = {
  baseUrl: "https://api.cline.bot/api/v1",
  model: "cline-pass/deepseek-v4.1-flash-1017",
  temperature: 0.4,
  maxTokens: 2048,
};

/** 网关把正文吞掉（推理 token 占满预算）时抛这个，调用方要翻成人话。 */
export class AiEmptyError extends Error {
  readonly code = "AI_EMPTY";
  constructor(message = "模型没给出正文") {
    super(message);
    this.name = "AiEmptyError";
  }
}

export class AiHttpError extends Error {
  readonly code = "AI_HTTP";
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`AI 网关返回 ${status}${detail ? `：${detail}` : ""}`);
    this.name = "AiHttpError";
    this.status = status;
  }
}

type Payload = Record<string, unknown>;

function pickChoices(payload: Payload): Payload[] {
  const inner = (payload.data as Payload | undefined) ?? payload;
  if (!inner || typeof inner !== "object") return [];
  const choices = (inner as Payload).choices;
  return Array.isArray(choices) ? (choices as Payload[]) : [];
}

/** 兼容标准 OpenAI 形状与网关偶发的 `{success, data:{choices}}` 两种。 */
export function normalizeResponse(payload: unknown): { content: string; reasoning: string | null } {
  const choices = pickChoices((payload ?? {}) as Payload);
  const message = (choices[0]?.message ?? {}) as Payload;
  const content = typeof message.content === "string" ? message.content : "";
  const reasoning =
    typeof message.reasoning === "string"
      ? message.reasoning
      : typeof message.reasoning_content === "string"
        ? (message.reasoning_content as string)
        : null;
  if (!content.trim()) throw new AiEmptyError();
  return { content, reasoning };
}

const SYSTEM_PROMPTS: Record<AiMode, string> = {
  expand:
    "你是学习笔记助手。把用户选中的内容扩写成结构化笔记：用 Markdown 小标题、要点列表、必要的一个例子。保留原意，不编造事实，不写客套话。",
  summarize:
    "你是学习笔记助手。把给定内容提炼成 3-6 条要点，只留关键结论与关键推理，不要复述原文。",
  explain:
    "你是学习笔记助手。用初学者能懂的方式解释选中的内容：先说它解决什么问题，再打一个类比，最后指出最容易误解的地方。",
  quiz: "你是学习笔记助手。基于给定笔记出 3 个复习问题，每题下面用 <details> 折叠写答案，问题要能检验理解而不是背原文。",
  continue:
    "你是学习笔记助手。顺着用户已有的思路往下写一段，保持他的语气与详略，不改变他前面的判断，只补他没展开的部分。",
  ask: "你是学习笔记助手。基于提供的笔记回答问题；笔记里没有的信息要明确说「笔记里没写」，不要凭空补。",
  polish:
    "你是中文技术笔记的编辑。润色给定内容：让它更通顺、更准确、层次更清楚。必须保留全部信息、观点、数据与 Markdown 结构（标题层级、列表、代码块、双链、标签都不许删改）。不要加解释、不要加开场白、不要用代码围栏包住整体，直接输出润色后的完整正文。",
  shorten:
    "你是中文技术笔记的编辑。精简给定内容：删掉重复、赘述与套话，保留所有关键结论、数据、例子与 Markdown 结构。不要加解释、不要用代码围栏包住整体，直接输出精简后的完整正文。",
  tidy:
    "你是 Markdown 排版助手。只规范格式、不改表达：统一标题层级（#/##/### 递进、不跳级）、列表符号统一为 `- `、中英文之间补空格、修正明显的错别字与标点、代码块标注语言、去掉多余空行。不许改写句子含义，不许增删内容，不许加解释，直接输出整理后的完整正文。",
  rewrite:
    "你是中文技术笔记的编辑。按用户「改写要求」修改给定内容，其余部分尽量保持不变；如果要求里说了删/加/换结构就照做。不编造事实，不加解释、不加开场白、不用代码围栏包住整体，直接输出改写后的完整正文（能直接覆盖原文）。",
};

export function buildMessages(
  mode: AiMode,
  input: {
    noteTitle: string;
    noteBody: string;
    selection?: string;
    question?: string;
    related?: Array<{ title: string; excerpt: string }>;
  },
): ChatMessage[] {
  const system = SYSTEM_PROMPTS[mode];
  const parts: string[] = [`当前笔记标题：${input.noteTitle || "（未命名）"}`];
  if (input.related && input.related.length > 0) {
    parts.push("可能相关的笔记：");
    for (const rel of input.related.slice(0, 3)) {
      parts.push(`- ${rel.title}：${rel.excerpt}`);
    }
  }
  if (mode === "ask") {
    parts.push(`问题：${input.question ?? ""}`);
    parts.push(`笔记正文：\n${input.noteBody.slice(0, 6000)}`);
  } else if (mode === "continue") {
    parts.push(`笔记正文（请从这里接着写）：\n${input.noteBody.slice(-4000)}`);
  } else if (REWRITE_MODES.has(mode)) {
    // 改稿类：有选中就只改选段，没选中就整篇；rewrite 必须带上用户的改写要求。
    if (mode === "rewrite") parts.push(`改写要求：${input.question?.trim() || "把这段写得更清楚"}`);
    if (input.selection && input.selection.trim()) {
      parts.push(`待改写的内容：\n${input.selection.slice(0, 6000)}`);
      if (input.noteBody) parts.push(`所在笔记正文（仅供理解上下文，不要整篇输出）：\n${input.noteBody.slice(0, 3000)}`);
    } else {
      parts.push(`待改写的完整正文：\n${input.noteBody.slice(0, 12000)}`);
    }
  } else if (input.selection && input.selection.trim()) {
    parts.push(`选中的内容：\n${input.selection.slice(0, 4000)}`);
    if (input.noteBody) parts.push(`所在笔记正文（供参考）：\n${input.noteBody.slice(0, 2000)}`);
  } else {
    parts.push(`笔记正文：\n${input.noteBody.slice(0, 6000)}`);
  }
  return [
    { role: "system", content: system },
    { role: "user", content: parts.join("\n\n") },
  ];
}

function extractDelta(payload: Payload): string {
  const choices = pickChoices(payload);
  const delta = (choices[0]?.delta ?? {}) as Payload;
  const content = delta.content;
  return typeof content === "string" ? content : "";
}

/** 网关卡住时不要挂到 undici 默认的 300s。 */
const AI_TIMEOUT_MS = 120_000;

/** 逐块产出正文增量；中途断开会抛出带 partial 的错误，已产出的内容不丢。 */
export async function* streamAi(
  cfg: AiConfig,
  messages: ChatMessage[],
  fetchImpl: typeof fetch = fetch,
  outerSignal?: AbortSignal,
): AsyncGenerator<string> {
  const timeout = AbortSignal.timeout(AI_TIMEOUT_MS);
  const signal = outerSignal ? AbortSignal.any([outerSignal, timeout]) : timeout;
  // 网关偶发 RST 会只丢一个 "fetch failed"，先自动重试一次再报错（此时还没读到任何字节）
  const res = await fetchWithRetry(fetchImpl, `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    signal,
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
      stream: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (text.includes("empty response content")) throw new AiEmptyError();
    throw new AiHttpError(res.status, text.slice(0, 300));
  }

  const reader = res.body?.getReader();
  if (!reader) throw new AiHttpError(0, "响应没有 body");

  const decoder = new TextDecoder();
  let buffer = "";
  let partial = "";
  try {
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
        let payload: Payload;
        try {
          payload = JSON.parse(data) as Payload;
        } catch {
          continue;
        }
        const delta = extractDelta(payload);
        if (delta) {
          partial += delta;
          yield delta;
        }
      }
    }
  } catch (err) {
    if (signal.aborted) {
      const cancelled = new Error(outerSignal?.aborted ? "生成已取消" : "生成超时（120s）") as Error & {
        partial?: string;
        code?: string;
      };
      cancelled.partial = partial;
      cancelled.code = outerSignal?.aborted ? "AI_CANCELLED" : "AI_TIMEOUT";
      throw cancelled;
    }
    const wrapped = new Error(`生成中断：${(err as Error).message}`) as Error & { partial?: string };
    wrapped.partial = partial;
    throw wrapped;
  }
  if (!partial.trim()) throw new AiEmptyError();
}

function configFile(dataDir: string): string {
  return path.join(dataDir, "config.json");
}

const PAPER_READER_CONFIG = "D:\\work\\paper-reader\\data\\config.json";

export type AiEnv = { baseUrl?: string; apiKey?: string; model?: string };

export function readAiEnv(): AiEnv {
  return {
    baseUrl: process.env.STUDY_AI_BASE_URL?.trim() || undefined,
    apiKey: process.env.STUDY_AI_KEY?.trim() || undefined,
    model: process.env.STUDY_AI_MODEL?.trim() || undefined,
  };
}

/** 读配置；没有就从 paper-reader 的本地配置里借三项（只落本地 data/config.json）。 */
export function loadAiConfig(dataDir: string, env: AiEnv = readAiEnv()): AiConfig | null {
  const file = configFile(dataDir);
  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<AiConfig>;
      const apiKey = env.apiKey ?? raw.apiKey ?? "";
      if (!apiKey) return null;
      return {
        baseUrl: env.baseUrl ?? raw.baseUrl ?? DEFAULT_AI.baseUrl,
        apiKey,
        model: env.model ?? raw.model ?? DEFAULT_AI.model,
        temperature: typeof raw.temperature === "number" ? raw.temperature : DEFAULT_AI.temperature,
        maxTokens: typeof raw.maxTokens === "number" ? raw.maxTokens : DEFAULT_AI.maxTokens,
      };
    } catch {
      return null;
    }
  }
  return bootstrapFromPaperReader(dataDir, env);
}

function bootstrapFromPaperReader(dataDir: string, env: AiEnv): AiConfig | null {
  let borrowed: { baseUrl?: string; apiKey?: string; model?: string } = {};
  try {
    if (fs.existsSync(PAPER_READER_CONFIG)) {
      const raw = JSON.parse(fs.readFileSync(PAPER_READER_CONFIG, "utf8")) as Record<string, unknown>;
      borrowed = {
        baseUrl: typeof raw.base_url === "string" ? raw.base_url : undefined,
        apiKey: typeof raw.api_key === "string" ? raw.api_key : undefined,
        model: typeof raw.model === "string" ? raw.model : undefined,
      };
    }
  } catch {
    borrowed = {};
  }
  const apiKey = env.apiKey ?? borrowed.apiKey ?? "";
  if (!apiKey) return null;
  const cfg: AiConfig = {
    baseUrl: env.baseUrl ?? borrowed.baseUrl ?? DEFAULT_AI.baseUrl,
    apiKey,
    model: env.model ?? borrowed.model ?? DEFAULT_AI.model,
    temperature: DEFAULT_AI.temperature,
    maxTokens: DEFAULT_AI.maxTokens,
  };
  try {
    saveAiConfig(dataDir, cfg);
  } catch {
    // 只读目录也不影响使用
  }
  return cfg;
}

export function saveAiConfig(dataDir: string, patch: Partial<AiConfig>): AiConfig {
  // 走通用 patchConfig（浅合并），保证 config.json 里的其它段（如 backup）不被覆盖。
  const current = readConfig(dataDir) as Partial<AiConfig>;
  const merged: AiConfig = {
    baseUrl: patch.baseUrl ?? current.baseUrl ?? DEFAULT_AI.baseUrl,
    apiKey: patch.apiKey ?? current.apiKey ?? "",
    model: patch.model ?? current.model ?? DEFAULT_AI.model,
    temperature: patch.temperature ?? current.temperature ?? DEFAULT_AI.temperature,
    maxTokens: patch.maxTokens ?? current.maxTokens ?? DEFAULT_AI.maxTokens,
  };
  patchConfig(dataDir, merged);
  return merged;
}

export function maskConfig(cfg: AiConfig | null) {
  if (!cfg) {
    return {
      baseUrl: DEFAULT_AI.baseUrl,
      model: DEFAULT_AI.model,
      apiKeyMasked: "",
      maxTokens: DEFAULT_AI.maxTokens,
      temperature: DEFAULT_AI.temperature,
      configured: false,
    };
  }
  return {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKeyMasked: cfg.apiKey ? `${cfg.apiKey.slice(0, 5)}…${cfg.apiKey.slice(-2)}` : "",
    maxTokens: cfg.maxTokens,
    temperature: cfg.temperature,
    configured: Boolean(cfg.apiKey),
  };
}
