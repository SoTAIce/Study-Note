import { maskSecret, patchSection, readSection } from "../config.ts";
import { loadAiConfig } from "../ai.ts";
import { streamAnthropicTurn } from "./anthropic.ts";
import { streamGeminiTurn } from "./gemini.ts";
import { streamOpenaiTurn } from "./openai.ts";
import type { ProviderConfig, ProviderEvent, ProviderRuntime, StreamRequest } from "./types.ts";

export * from "./types.ts";

export type ProvidersFile = { activeId: string; items: ProviderConfig[] };

const SECTION = "providers";

const DEFAULT_ITEMS: ProviderConfig[] = [
  {
    id: "deepseek",
    kind: "openai",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "",
    models: ["deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-chat",
  },
  {
    id: "claude",
    kind: "anthropic",
    label: "Claude",
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "",
    models: ["claude-sonnet-4-5", "claude-opus-4-1"],
    defaultModel: "claude-sonnet-4-5",
  },
  {
    id: "gemini",
    kind: "gemini",
    label: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey: "",
    models: ["gemini-2.5-pro", "gemini-2.5-flash"],
    defaultModel: "gemini-2.5-pro",
  },
  {
    id: "ollama",
    kind: "openai",
    label: "Ollama（本地）",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey: "",
    models: [],
    defaultModel: "",
  },
  {
    id: "custom",
    kind: "openai",
    label: "自定义（OpenAI 兼容）",
    baseUrl: "",
    apiKey: "",
    models: [],
    defaultModel: "",
  },
];

function isKind(value: unknown): value is ProviderConfig["kind"] {
  return value === "openai" || value === "anthropic" || value === "gemini";
}

function normalizeItem(raw: unknown): ProviderConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Partial<ProviderConfig>;
  if (typeof item.id !== "string" || !item.id) return null;
  return {
    id: item.id,
    kind: isKind(item.kind) ? item.kind : "openai",
    label: typeof item.label === "string" ? item.label : item.id,
    baseUrl: typeof item.baseUrl === "string" ? item.baseUrl : "",
    apiKey: typeof item.apiKey === "string" ? item.apiKey : "",
    models: Array.isArray(item.models) ? item.models.map(String) : [],
    defaultModel: typeof item.defaultModel === "string" ? item.defaultModel : "",
  };
}

export function loadProviders(dataDir: string): ProvidersFile {
  const section = readSection<{ activeId?: string; items?: unknown[] }>(dataDir, SECTION);
  const items = Array.isArray(section.items)
    ? section.items.map(normalizeItem).filter((item): item is ProviderConfig => item !== null)
    : [];
  if (items.length > 0) {
    return { activeId: typeof section.activeId === "string" && section.activeId ? section.activeId : items[0].id, items };
  }

  // 没配过新版服务商时，把旧版单服务商配置直接搬过来，用户原先的 key 立刻可用
  const legacy = loadAiConfig(dataDir);
  if (legacy && legacy.baseUrl && legacy.apiKey) {
    return {
      activeId: "legacy",
      items: [
        {
          id: "legacy",
          kind: "openai",
          label: "沿用原有 AI 配置",
          baseUrl: legacy.baseUrl,
          apiKey: legacy.apiKey,
          models: [legacy.model],
          defaultModel: legacy.model,
        },
      ],
    };
  }

  // 首次使用：给出五张卡片（key 为空，等用户填）
  return {
    activeId: "deepseek",
    items: DEFAULT_ITEMS.map((item) => ({ ...item })),
  };
}

export function saveProviders(
  dataDir: string,
  patch: { activeId?: string; items?: ProviderConfig[]; clearApiKeys?: string[] },
): void {
  const current = loadProviders(dataDir);
  const byId = new Map(current.items.map((item) => [item.id, item]));
  const clear = new Set(patch.clearApiKeys ?? []);

  // 前端拿到的永远是掩码版的配置，它回传时根本不可能带明文 key。
  // 所以这里必须按 id 合并：没给 key 就沿用旧的，绝不能被空串覆盖掉（否则用户只改个模型就把 key 清空了）。
  const items = patch.items
    ? patch.items
        .map(normalizeItem)
        .filter((item): item is ProviderConfig => item !== null)
        .map((item) => {
          const old = byId.get(item.id);
          const incomingKey = item.apiKey.trim();
          const apiKey = clear.has(item.id) ? "" : incomingKey || old?.apiKey || "";
          const models = item.models.length > 0 ? item.models : old?.models ?? [];
          return { ...item, apiKey, models };
        })
    : current.items;

  const activeId = patch.activeId ?? current.activeId;
  patchSection(dataDir, SECTION, { activeId, items });
}

export function maskProviders(cfg: ProvidersFile) {
  return {
    activeId: cfg.activeId,
    items: cfg.items.map(({ apiKey, ...rest }) => ({
      ...rest,
      apiKeyMasked: maskSecret(apiKey),
      configured: Boolean(apiKey),
    })),
  };
}

/** 按 kind 分派到对应适配器。 */
export function streamTurn(
  runtime: ProviderRuntime,
  req: StreamRequest,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  const common = {
    baseUrl: runtime.baseUrl,
    apiKey: runtime.apiKey,
    model: runtime.model,
    maxTokens: runtime.maxTokens,
    ...req,
  };
  if (runtime.kind === "openai") return streamOpenaiTurn(common, fetchImpl, signal);
  if (runtime.kind === "anthropic") return streamAnthropicTurn(common, fetchImpl, signal);
  if (runtime.kind === "gemini") return streamGeminiTurn(common, fetchImpl, signal);
  throw Object.assign(new Error(`暂不支持的服务商类型：${String(runtime.kind)}`), { code: "AI_UNSUPPORTED" });
}

export function runtimeOf(cfg: ProvidersFile, providerId?: string, model?: string): ProviderRuntime {
  const id = providerId || cfg.activeId;
  const item = cfg.items.find((entry) => entry.id === id);
  if (!item) throw Object.assign(new Error(`找不到服务商：${id}`), { code: "NO_PROVIDER" });
  if (!item.baseUrl) throw Object.assign(new Error(`服务商 ${item.label} 还没填地址`), { code: "NO_PROVIDER" });
  // 本地服务（Ollama 等）不需要 key；远程服务没有 key 就等于没配置
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/i.test(item.baseUrl);
  if (!isLocal && !item.apiKey) throw Object.assign(new Error(`服务商 ${item.label} 还没填 API Key`), { code: "NO_PROVIDER" });
  const picked = model || item.defaultModel || item.models[0] || "";
  if (!picked) throw Object.assign(new Error(`服务商 ${item.label} 还没选模型`), { code: "NO_MODEL" });
  return { kind: item.kind, baseUrl: item.baseUrl, apiKey: item.apiKey, model: picked };
}
