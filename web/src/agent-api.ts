import { ApiError, isRecord, jsonBody, parseData, request } from "./api.ts";
import { SseSplitter } from "./lib/sse.ts";
import type { PlanOpView } from "./lib/plan-view.ts";

// —— 类型 ——

export type ProviderView = {
  id: string;
  kind: "openai" | "anthropic" | "gemini";
  label: string;
  baseUrl: string;
  models: string[];
  defaultModel: string;
  apiKeyMasked: string;
  configured: boolean;
};

export type ProvidersView = { activeId: string; items: ProviderView[] };

export type ChatSummary = { id: string; title: string; updatedAt: string; model: string };

export type StoredPlanView = {
  id: string;
  summary: string;
  status: "pending" | "executed" | "undone";
  createdAt: string;
  ops: Array<PlanOpView & { after?: string; before?: { exists: boolean; raw: string } }>;
  results?: Array<{ index: number; status: "ok" | "conflict" | "error"; error?: string }>;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
};

export type ChatDetail = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  providerId: string;
  model: string;
  messages: ChatMessage[];
  plans: StoredPlanView[];
};

export type AgentStep = {
  id: string;
  name: string;
  args: unknown;
  status: "running" | "ok" | "error";
  summary?: string;
  ms: number;
};

export type AgentEvent =
  | { type: "text"; delta: string }
  | ({ type: "step" } & AgentStep)
  | { type: "plan"; messageId: string; plan: { id: string; summary: string; ops: PlanOpView[] } }
  | { type: "done"; messageId: string }
  | { type: "error"; code: string; message: string }
  | { type: "cancelled" };

export type RootView = { readRoots: string[]; notesRoot: string };

export type ExecuteResult = { ok: boolean; results: Array<{ index: number; status: "ok" | "conflict" | "error"; error?: string }> };
export type UndoResult = { ok: boolean; restored: number; skipped: Array<{ path: string; reason: string }> };

// —— 服务商与目录 ——

export function getAgentProviders(): Promise<ProvidersView> {
  return request<ProvidersView>("/agent/providers");
}

export function saveAgentProviders(patch: {
  activeId?: string;
  items?: Array<Partial<ProviderView> & { id: string; apiKey?: string }>;
}): Promise<ProvidersView> {
  return request<ProvidersView>("/agent/providers", { method: "PUT", body: jsonBody(patch) });
}

export function testAgentProvider(id: string): Promise<{ ok: boolean; model?: string; sample?: string; error?: string; code?: string }> {
  return request(`/agent/providers/${encodeURIComponent(id)}/test`, { method: "POST", body: jsonBody({}) });
}

export function getAgentRoots(): Promise<RootView> {
  return request<RootView>("/agent/roots");
}

export function saveAgentRoots(readRoots: string[]): Promise<RootView> {
  return request<RootView>("/agent/roots", { method: "PUT", body: jsonBody({ readRoots }) });
}

// —— 会话 ——

export async function listAgentChats(): Promise<ChatSummary[]> {
  const data = await request<{ items?: ChatSummary[] }>("/agent/chats");
  return Array.isArray(data.items) ? data.items : [];
}

export function createAgentChat(init: { providerId?: string; model?: string } = {}): Promise<ChatDetail> {
  return request<ChatDetail>("/agent/chats", { method: "POST", body: jsonBody(init) });
}

export function getAgentChat(id: string): Promise<ChatDetail> {
  return request<ChatDetail>(`/agent/chats/${encodeURIComponent(id)}`);
}

export function patchAgentChat(id: string, patch: { title?: string; model?: string; providerId?: string }): Promise<ChatDetail> {
  return request<ChatDetail>(`/agent/chats/${encodeURIComponent(id)}`, { method: "PATCH", body: jsonBody(patch) });
}

export function deleteAgentChat(id: string): Promise<{ ok: boolean }> {
  return request(`/agent/chats/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// —— 计划 ——

export function getAgentPlan(planId: string): Promise<{ chatId: string; plan: StoredPlanView }> {
  return request(`/agent/plans/${encodeURIComponent(planId)}`);
}

export function executeAgentPlan(planId: string, skip: number[] = []): Promise<ExecuteResult> {
  return request<ExecuteResult>(`/agent/plans/${encodeURIComponent(planId)}/execute`, {
    method: "POST",
    body: jsonBody({ skip }),
  });
}

export function undoAgentPlan(planId: string): Promise<UndoResult> {
  return request<UndoResult>(`/agent/plans/${encodeURIComponent(planId)}/undo`, {
    method: "POST",
    body: jsonBody({}),
  });
}

// —— 发消息（SSE）——

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/**
 * POST /api/agent/chats/:id/messages，逐块读 SSE：
 * event: text | step | plan | done | error | cancelled。
 */
export async function sendAgentMessage(
  chatId: string,
  text: string,
  handlers: {
    onEvent: (event: AgentEvent) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/agent/chats/${encodeURIComponent(chatId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: jsonBody({ text }),
      signal: handlers.signal,
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new ApiError(0, "连不上本地服务，请确认 Study Notes 已启动");
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let message = raw.slice(0, 200);
    let code = "AGENT_ERROR";
    try {
      const payload: unknown = JSON.parse(raw);
      if (isRecord(payload)) {
        if (typeof payload.error === "string") message = payload.error;
        if (typeof payload.code === "string") code = payload.code;
      }
    } catch {
      /* 原样用文本 */
    }
    throw new ApiError(res.status, message || `请求失败（${res.status}）`, { code });
  }

  const reader = res.body?.getReader();
  if (!reader) throw new ApiError(0, "响应没有 body");
  const decoder = new TextDecoder();
  const splitter = new SseSplitter();

  const dispatch = (blocks: Array<{ event: string; data: string }>) => {
    for (const block of blocks) {
      const payload = parseData(block.data);
      if (!payload) continue;
      const type = typeof payload.type === "string" ? payload.type : block.event;
      handlers.onEvent({ ...(payload as object), type } as AgentEvent);
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      dispatch(splitter.push(decoder.decode(value, { stream: true })));
    }
    // 有的网关最后一块不带空行，flush 出来补发
    dispatch(splitter.flush());
  } catch (err) {
    if (isAbort(err)) return;
    throw err;
  }
}
