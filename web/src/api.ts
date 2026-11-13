/**
 * 类型化 API 客户端。字段与 server/api.ts 的返回逐一对齐，不臆造字段。
 * 所有错误统一抛 ApiError（带 HTTP status 与原始 payload），409 冲突可识别。
 */

import type { IndexChanges } from "./lib/save-plan.ts";

export type NoteType = "note" | "idea" | "source";

export type NoteSummary = {
  id: string;
  relPath: string;
  title: string;
  type: NoteType;
  created: string;
  updated: string;
  excerpt: string;
  tags: string[];
  group: string | null;
};

export type NoteMeta = {
  id: string;
  title: string;
  created: string;
  updated: string;
  type: NoteType;
  tags: string[];
  group?: string;
  source?: string;
};

export type NoteDetail = {
  id: string;
  relPath: string;
  meta: NoteMeta;
  body: string;
  hash: string;
  mtime: string;
  tags: string[];
  /** 所属分组；未分组为 null */
  group?: string | null;
};

export type SaveResult = {
  id: string;
  relPath: string;
  hash: string;
  meta: NoteMeta;
  body: string;
  /** 列表摘要（与 /notes 列表一致） */
  excerpt?: string;
  /** 索引里的标签：frontmatter + 正文 #标签 */
  indexTags?: string[];
  /** 这次保存让标题 / 标签 / 类型分组 / 链接变了没有（perf-001） */
  changes?: IndexChanges;
};

export type CreateInput = {
  title?: string;
  body: string;
  tags?: string[];
  type?: NoteType;
  source?: string;
  group?: string | null;
};

export type SaveInput = {
  body: string;
  baseHash: string;
  title?: string;
  tags?: string[];
  /** 强制在历史版本里存一份「保存前」：edit = 打开后的第一次保存，ai = AI 改写后的保存 */
  checkpoint?: "edit" | "ai";
};

export type SearchHit = {
  id: string;
  relPath: string;
  title: string;
  /** 命中词已由服务端转义并包成 <mark>…</mark>，可直接 innerHTML。 */
  snippet: string;
  score: number;
  updated: string;
};

export type Backlink = { id: string; title: string; relPath: string };
export type Outlink = { title: string; targetId: string | null; resolved: boolean };
export type BacklinksResult = { backlinks: Backlink[]; outlinks: Outlink[] };

export type TimelineItem = {
  id: string;
  relPath: string;
  title: string;
  type: NoteType;
  created: string;
  updated: string;
};

export type TagCount = { tag: string; count: number };
export type TrashItem = { name: string; origPath: string; deletedAt: string };
export type CaptureResult = { id: string; relPath: string; title: string };

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

/** 产出「可直接覆盖正文的完整版本」的动作，前端据此把主按钮换成「整篇替换」。 */
export const REWRITE_MODES: ReadonlySet<AiMode> = new Set<AiMode>(["polish", "shorten", "tidy", "rewrite"]);

export type AiConfig = {
  baseUrl: string;
  model: string;
  apiKeyMasked: string;
  maxTokens: number;
  temperature: number;
  configured: boolean;
};

export type AiConfigPatch = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
};

export type AiInput = {
  noteId?: string;
  title?: string;
  body?: string;
  selection?: string;
  question?: string;
};

export type ConflictInfo = {
  error: string;
  currentHash: string;
  diskUpdated: string;
};

// —— 备份（通用 WebDAV）——

/** GET /api/backup：是否已配置、上次结果、待传篇数、下次自动时间。 */
export type BackupStatus = {
  configured: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  pending: number;
  nextRunAt: string | null;
  snapshots: number;
  keepDays: number;
};

/** GET /api/backup/config：应用密码一律是掩码，前端拿不到明文。 */
export type BackupConfigView = {
  url: string;
  account: string;
  passwordMasked: string;
  remoteRoot: string;
  intervalMinutes: number;
  keepDays: number;
};

export type BackupConfigPatch = {
  url?: string;
  account?: string;
  /** 空字符串或缺省 = 不改（把掩码串回传会把真密码覆盖掉）。 */
  password?: string;
  remoteRoot?: string;
  intervalMinutes?: number;
  keepDays?: number;
};

export type SnapshotDay = {
  day: string;
  files: number;
  bytes: number;
  monthly: boolean;
};

/** 快照里的一个文件；服务端只从 manifest 拿到路径，bytes 可能为 0。 */
export type SnapshotFile = { path: string; bytes: number };

export type BackupRunResult = {
  ok: boolean;
  skipped: boolean;
  uploaded: number;
  tookMs: number;
};

/** POST /api/backup/restore：created 表示这篇原本本地已不存在（按原路径复活）。 */
export type RestoreResult = { hash: string; created: boolean; id?: string; relPath?: string };

const DEFAULT_AI_CONFIG: AiConfig = {
  baseUrl: "",
  model: "",
  apiKeyMasked: "",
  maxTokens: 2048,
  temperature: 0.4,
  configured: false,
};

export class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, message: string, payload: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

export class AiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AiError";
    this.code = code;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  let res: Response;
  try {
    res = await fetch(`/api${path}`, { ...init, headers });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new ApiError(0, "连不上本地服务，请确认 Study Notes 已启动", err);
  }

  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!res.ok) {
    const message =
      isRecord(payload) && typeof payload.error === "string"
        ? payload.error
        : `请求失败（HTTP ${res.status}）`;
    throw new ApiError(res.status, message, payload);
  }

  return payload as T;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 把 409 响应识别成界面可直接用的冲突信息。 */
export function conflictInfo(err: unknown): ConflictInfo | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const payload = isRecord(err.payload) ? err.payload : {};
  return {
    error: typeof payload.error === "string" ? payload.error : "文件已被外部修改",
    currentHash: typeof payload.currentHash === "string" ? payload.currentHash : "",
    diskUpdated: typeof payload.diskUpdated === "string" ? payload.diskUpdated : "",
  };
}

function isAbort(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (isRecord(err) && err.name === "AbortError")
  );
}

// —— 笔记 ——

export function listNotes(
  opts: { type?: NoteType; tag?: string; group?: string } = {},
): Promise<{ items: NoteSummary[] }> {
  return request(`/notes${query({ type: opts.type, tag: opts.tag, group: opts.group })}`);
}

export function getNote(id: string): Promise<NoteDetail> {
  return request(`/notes/${encodeURIComponent(id)}`);
}

export function createNote(input: CreateInput): Promise<SaveResult & { body: string }> {
  return request("/notes", { method: "POST", body: jsonBody(input) });
}

export function saveNote(id: string, input: SaveInput): Promise<SaveResult> {
  return request(`/notes/${encodeURIComponent(id)}`, { method: "PUT", body: jsonBody(input) });
}

// —— 历史版本 ——

export type HistoryReason = "edit" | "ai" | "restore" | "backup-restore" | "agent";

export type HistoryEntry = {
  versionId: string;
  /** 这份内容当时的保存时间 */
  at: string;
  /** 快照拍摄时间（被哪次保存覆盖） */
  takenAt: string;
  reason: HistoryReason;
  title: string;
  chars: number;
  bytes: number;
};

export type HistoryVersion = HistoryEntry & { meta: NoteMeta; body: string };

export function listHistory(id: string): Promise<{ items: HistoryEntry[] }> {
  return request(`/notes/${encodeURIComponent(id)}/history`);
}

export function getHistoryVersion(id: string, versionId: string): Promise<HistoryVersion> {
  return request(`/notes/${encodeURIComponent(id)}/history/${encodeURIComponent(versionId)}`);
}

export function restoreHistoryVersion(id: string, versionId: string, baseHash: string): Promise<SaveResult> {
  return request(`/notes/${encodeURIComponent(id)}/history/${encodeURIComponent(versionId)}/restore`, {
    method: "POST",
    body: jsonBody({ baseHash }),
  });
}

export function deleteNote(id: string): Promise<{ ok: true; name: string }> {
  return request(`/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// —— 检索 / 标签 / 时间流 / 反查 ——

export function searchNotes(
  q: string,
  opts: { tag?: string; limit?: number } = {},
): Promise<{ items: SearchHit[] }> {
  return request(`/search${query({ q, tag: opts.tag, limit: opts.limit })}`);
}

export function getTags(): Promise<{ items: TagCount[] }> {
  return request("/tags");
}

export function getTimeline(opts: { from?: string; to?: string } = {}): Promise<{
  items: TimelineItem[];
}> {
  return request(`/timeline${query({ from: opts.from, to: opts.to })}`);
}

export function getBacklinks(id: string): Promise<BacklinksResult> {
  return request(`/backlinks/${encodeURIComponent(id)}`);
}

// —— 回收站 / 捕获 / 索引 ——

export function getTrash(): Promise<{ items: TrashItem[] }> {
  return request("/trash");
}

export function restoreTrash(name: string): Promise<{ ok: true; relPath: string }> {
  return request(`/trash/${encodeURIComponent(name)}/restore`, { method: "POST" });
}

/** 笔记在外部被删时，把编辑器里的内容（含未保存修改）存进回收站；内容相同的已在回收站时 skipped = true。 */
export function salvageToTrash(input: {
  relPath: string;
  meta: NoteMeta;
  body: string;
}): Promise<{ ok: true; name: string; skipped: boolean }> {
  return request("/trash/salvage", { method: "POST", body: jsonBody(input) });
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

export function capture(text: string, tags?: string[]): Promise<CaptureResult> {
  return request("/capture", {
    method: "POST",
    body: jsonBody(tags && tags.length ? { text, tags } : { text }),
  });
}

export function reindex(): Promise<{ ok: true; indexed: number; removed: number; failed?: number }> {
  return request("/reindex", { method: "POST" });
}

// —— AI 配置 ——

/** GET /api/config；服务端还没上线该接口时返回 available:false 而不是抛错。 */
export async function getAiConfig(): Promise<{ config: AiConfig; available: boolean }> {
  try {
    const config = await request<AiConfig>("/config");
    return { config, available: true };
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 0)) {
      return { config: { ...DEFAULT_AI_CONFIG }, available: false };
    }
    throw err;
  }
}

export function putAiConfig(patch: AiConfigPatch): Promise<AiConfig> {
  return request("/config", { method: "PUT", body: jsonBody(patch) });
}

/** 采纳建议后尽力回写 ai_calls.inserted；失败不影响插入本身。 */
export async function acceptAi(callId: number | null): Promise<void> {
  if (!callId) return;
  try {
    await request("/ai/accept", { method: "POST", body: jsonBody({ callId }) });
  } catch {
    // 统计接口缺失/失败不打扰使用者。
  }
}

/** 把网关/服务端错误翻译成可读中文。 */
export function friendlyAiMessage(input: unknown, code?: string): string {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof Error
        ? input.message
        : "";
  const effectiveCode = code ?? (isRecord(input) && typeof input.code === "string" ? input.code : "");

  if (effectiveCode === "AI_UNCONFIGURED" || /未配置/.test(raw)) {
    return "AI 未配置：点这里填 key";
  }
  if (effectiveCode === "AI_EMPTY" || /empty response content|没给出正文/i.test(raw)) {
    return "模型没给出正文，换个说法或调大长度（maxTokens）";
  }
  if (/连不上|fetch failed|ECONNREFUSED|ENOTFOUND|network|Failed to fetch/i.test(raw)) {
    return "连不上 AI 网关，检查 baseUrl 和网络后再试";
  }
  if (/超时|timeout/i.test(raw)) {
    return "AI 网关超时了，稍后重试";
  }
  if (/网关返回\s*5\d\d/.test(raw)) {
    return `${raw}，稍后重试，或把 maxTokens 调大`;
  }
  return raw || "AI 调用失败，稍后重试";
}

// —— AI SSE ——

type SseEvent = { event: string; data: string };

export function parseSseBlock(block: string): SseEvent {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const idx = line.indexOf(":");
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? "" : line.slice(idx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return { event, data: data.join("\n") };
}

export function parseData(data: string): Record<string, unknown> | null {
  if (!data) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export type AiDone = { callId: number | null };

/**
 * POST /api/ai/:mode，逐条读取 `data: {"delta":"..."}`，结束 event: done。
 * 错误统一抛 AiError，message 已中文可读。
 */
export async function streamAi(
  mode: AiMode,
  input: AiInput,
  handlers: {
    onDelta: (delta: string) => void;
    signal?: AbortSignal;
  },
): Promise<AiDone> {
  let res: Response;
  try {
    res = await fetch(`/api/ai/${mode}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: jsonBody(input),
      signal: handlers.signal,
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new AiError("AI_UNAVAILABLE", "连不上本地服务，请确认 Study Notes 已启动");
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    const record = isRecord(payload) ? payload : {};
    const rawMessage =
      typeof record.error === "string" ? record.error : typeof payload === "string" ? payload : "";
    const code =
      typeof record.code === "string"
        ? record.code
        : res.status === 503
          ? "AI_UNCONFIGURED"
          : res.status === 404
            ? "AI_UNAVAILABLE"
            : "AI_HTTP";
    throw new AiError(code, friendlyAiMessage(rawMessage || `AI 请求失败（HTTP ${res.status}）`, code));
  }

  if (!res.body) throw new AiError("AI_ERROR", "当前浏览器不支持流式读取，换个浏览器试试");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let callId: number | null = null;

  const handle = (block: string): boolean => {
    const { event, data } = parseSseBlock(block);
    if (event === "done") {
      const payload = parseData(data);
      const id = payload?.callId;
      callId = typeof id === "number" ? id : null;
      return true;
    }
    if (event === "error") {
      const payload = parseData(data);
      const code = typeof payload?.code === "string" ? payload.code : "AI_ERROR";
      const message = typeof payload?.message === "string" ? payload.message : "AI 调用失败";
      if (typeof payload?.callId === "number") callId = payload.callId;
      throw new AiError(code, friendlyAiMessage(message, code));
    }
    const payload = parseData(data);
    if (payload && typeof payload.delta === "string" && payload.delta) {
      handlers.onDelta(payload.delta);
    }
    return false;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        if (handle(block)) {
          await reader.cancel().catch(() => undefined);
          return { callId };
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() && handle(buffer)) {
      return { callId };
    }
    return { callId };
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (isAbort(err)) throw err;
    throw new AiError("AI_STREAM", `AI 流式中断了：${errorMessage(err)}`);
  } finally {
    reader.releaseLock();
  }
}

// —— 备份（通用 WebDAV）——

/**
 * 列表类接口的返回形态：现有约定是 `{ items: […] }`，但备份接口是并行开发的，
 * 这里也认直接给数组 / `{ files }`，省得联调时因为一层包装白跑一趟。
 */
function pickList<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (!isRecord(payload)) return [];
  const list = payload.items ?? payload.files;
  return Array.isArray(list) ? (list as T[]) : [];
}

export function getBackupStatus(): Promise<BackupStatus> {
  return request("/backup");
}

/** POST /api/backup：手动一键备份（不受自动间隔限制）。 */
export function runBackup(): Promise<BackupRunResult> {
  return request("/backup", { method: "POST" });
}

/** POST /api/backup/test：只探测 WebDAV 根目录能否访问，不上传任何东西。 */
export function testBackup(): Promise<{ ok: boolean; message?: string }> {
  return request("/backup/test", { method: "POST" });
}

export function getBackupConfig(): Promise<BackupConfigView> {
  return request("/backup/config");
}

export function saveBackupConfig(patch: BackupConfigPatch): Promise<BackupConfigView> {
  return request("/backup/config", { method: "PUT", body: jsonBody(patch) });
}

/** GET /api/backup/snapshots：快照日期列表（服务端按日期倒序给）。 */
export async function getSnapshots(): Promise<SnapshotDay[]> {
  const payload = await request<unknown>("/backup/snapshots");
  return pickList<unknown>(payload)
    .filter(isRecord)
    .map((entry) => ({
      day: typeof entry.day === "string" ? entry.day : "",
      files: typeof entry.files === "number" ? entry.files : 0,
      bytes: typeof entry.bytes === "number" ? entry.bytes : 0,
      monthly: entry.monthly === true,
    }))
    .filter((entry) => entry.day !== "");
}

/** GET /api/backup/snapshots/:day：该快照里的文件列表。 */
export async function getSnapshotFiles(day: string): Promise<SnapshotFile[]> {
  const payload = await request<unknown>(`/backup/snapshots/${encodeURIComponent(day)}`);
  return pickList<unknown>(payload)
    .map((entry) => {
      if (isRecord(entry)) {
        return {
          path: typeof entry.path === "string" ? entry.path : "",
          bytes: typeof entry.bytes === "number" ? entry.bytes : 0,
        };
      }
      return { path: typeof entry === "string" ? entry : "", bytes: 0 };
    })
    .filter((file) => file.path !== "");
}

/**
 * GET /api/backup/snapshots/:day/file?path=
 * 取回快照里那一篇的原始 .md 文本。服务端可能直接给纯文本，也可能包成 `{ body }`，
 * 这里统一成字符串，调用方不用关心是哪一种。
 */
export async function getSnapshotFile(day: string, relPath: string): Promise<string> {
  const payload = await request<unknown>(
    `/backup/snapshots/${encodeURIComponent(day)}/file?path=${encodeURIComponent(relPath)}`,
  );
  if (typeof payload === "string") return payload;
  if (isRecord(payload)) {
    const body = payload.body ?? payload.content ?? payload.raw;
    if (typeof body === "string") return body;
  }
  throw new ApiError(502, "读不出快照内容（服务端返回结构不认识）", payload);
}

/**
 * POST /api/backup/restore
 *
 * `baseHash` 传**编辑器里当前这篇的 hash**（不是"刚从快照取回的内容"的 hash），
 * 这样服务端能拿它做乐观锁：不一致就 409，调用方用 `conflictInfo(err)` 识别成冲突提示。
 * 传空串表示本地没有正开着的同名版本，不需要乐观锁（例如恢复一篇已删除的笔记）。
 */
export function restoreFromSnapshot(day: string, relPath: string, baseHash: string): Promise<RestoreResult> {
  return request("/backup/restore", {
    method: "POST",
    body: jsonBody({ day, relPath, baseHash }),
  });
}
