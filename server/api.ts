import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  AiEmptyError,
  buildMessages,
  loadAiConfig,
  maskConfig,
  REWRITE_MODES,
  saveAiConfig,
  streamAi,
  type AiConfig,
  type AiMode,
} from "./ai.ts";
import { sendJson } from "./app.ts";
import {
  createChat,
  ChatError,
  deleteChat,
  findPlan,
  getChat,
  listChats,
  patchChat,
} from "./agent-chats.ts";
import { executePlan, undoPlan } from "./agent-exec.ts";
import { runTurn, type StreamTurn } from "./agent.ts";
import { createTools } from "./agent-tools.ts";
import { readSection, patchSection } from "./config.ts";
import { createGroup, deleteGroup, GroupsHttpError, groupsOverview, renameGroup } from "./groups-api.ts";
import { upsertGroup, validateGroupName } from "./groups.ts";
import { loadProviders, maskProviders, runtimeOf, saveProviders, streamTurn } from "./providers/index.ts";
import { sseStart } from "./sse.ts";
import {
  describeWebdavError,
  loadBackupConfig,
  maskBackupConfig,
  saveBackupConfig,
  type BackupService,
} from "./backup.ts";
import type { Indexer } from "./indexer.ts";
import type { NoteType } from "./parse.ts";
import { search } from "./search.ts";
import { ConflictError, toLocalIso, type NoteStore } from "./store.ts";

const MAX_BODY = 5 * 1024 * 1024;

const AI_MODES: AiMode[] = [
  "expand",
  "summarize",
  "explain",
  "quiz",
  "continue",
  "ask",
  "polish",
  "shorten",
  "tidy",
  "rewrite",
];

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type ApiDeps = {
  store: NoteStore;
  indexer: Indexer;
  db: DatabaseSync;
  dataDir?: string;
  now?: () => Date;
  aiFetch?: typeof fetch;
  backup?: BackupService;
  /** 测试注入：替掉真实的服务商流式调用 */
  agentStream?: StreamTurn;
};

type NoteRow = {
  id: string;
  path: string;
  title: string;
  type: string;
  created: string;
  updated: string;
  excerpt: string;
  group: string | null;
  hash: string | null;
};

function summarize(row: NoteRow, tags: string[]) {
  return {
    id: row.id,
    relPath: row.path,
    title: row.title,
    type: row.type,
    created: row.created,
    updated: row.updated,
    excerpt: row.excerpt,
    tags,
    group: row.group,
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new HttpError(413, "请求体过大（上限 5MB）");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("必须是对象");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "JSON 解析失败");
  }
}

export function createApi(deps: ApiDeps) {
  const { store, indexer, db } = deps;
  const dataDir = deps.dataDir ?? path.dirname(store.notesRoot);

  function findNote(id: string): NoteRow {
    const row = db
      .prepare(
        'SELECT id, path, title, type, created, updated, excerpt, group_name AS "group", content_hash AS hash FROM notes WHERE id = ?',
      )
      .get(id) as NoteRow | undefined;
    if (!row) throw new HttpError(404, `笔记不存在：${id}`);
    return row;
  }

  /** 把请求里的 group 规整成可落盘的值：非空则校验（不登记分组）。 */
  function groupValue(raw: unknown): string | null {
    if (raw === null || raw === undefined || raw === "") return null;
    if (typeof raw !== "string") throw new HttpError(400, "参数错误：group 必须是字符串");
    const check = validateGroupName(raw);
    if (!check.ok) throw new HttpError(400, `参数错误：${check.error}`);
    return check.name;
  }

  /** 校验并把分组登记到 groups.json（新建笔记时立刻可见）。 */
  function groupInput(raw: unknown): string | null {
    const name = groupValue(raw);
    if (name) upsertGroup(dataDir, name);
    return name;
  }

  function tagsOf(id: string): string[] {
    return (db.prepare("SELECT tag FROM tags WHERE note_id = ? ORDER BY tag").all(id) as Array<{
      tag: string;
    }>).map((t) => t.tag);
  }

  function reindex(relPath: string): void {
    indexer.ignoreNext(relPath);
    indexer.indexFile(relPath);
  }

  const groupsDeps = { db, store, dataDir, reindex };

  return async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const method = (req.method ?? "GET").toUpperCase();
    const seg = url.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
    if (seg[0] !== "api") return false;
    const route = seg.slice(1);

    try {
      // /api/notes
      if (route[0] === "notes" && route.length === 1) {
        if (method === "GET") {
          const type = url.searchParams.get("type");
          const tag = url.searchParams.get("tag");
          const rawGroup = url.searchParams.get("group");
          const where: string[] = [];
          const params: Array<string> = [];
          if (type) {
            where.push("n.type = ?");
            params.push(type);
          }
          if (tag) {
            where.push("n.id IN (SELECT note_id FROM tags WHERE tag = ?)");
            params.push(tag);
          }
          if (rawGroup && rawGroup.trim().toLowerCase() === "none") {
            where.push("(n.group_name IS NULL OR n.group_name = '')");
          } else if (rawGroup) {
            where.push("lower(n.group_name) = lower(?)");
            params.push(rawGroup);
          }
          const rows = db
            .prepare(
              `SELECT n.id, n.path, n.title, n.type, n.created, n.updated, n.excerpt, n.group_name AS "group"
                 FROM notes n ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                ORDER BY n.updated DESC, n.path LIMIT 2000`,
            )
            .all(...params) as NoteRow[];
          const tagRows = db.prepare("SELECT note_id, tag FROM tags").all() as Array<{
            note_id: string;
            tag: string;
          }>;
          const byNote = new Map<string, string[]>();
          for (const t of tagRows) {
            const list = byNote.get(t.note_id) ?? [];
            list.push(t.tag);
            byNote.set(t.note_id, list);
          }
          sendJson(res, 200, {
            items: rows.map((row) => summarize(row, (byNote.get(row.id) ?? []).sort())),
          });
          return true;
        }
        if (method === "POST") {
          const body = await readJson(req);
          const text = typeof body.body === "string" ? body.body : "";
          const group = groupInput(body.group);
          const note = store.create({
            title: typeof body.title === "string" ? body.title : undefined,
            body: text,
            tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
            type: body.type === "idea" || body.type === "source" ? (body.type as NoteType) : "note",
            source: typeof body.source === "string" ? body.source : undefined,
            group,
          });
          reindex(note.relPath);
          sendJson(res, 201, {
            id: note.id,
            relPath: note.relPath,
            hash: note.hash,
            meta: note.parsed.meta,
            body: note.parsed.body,
          });
          return true;
        }
      }

      // /api/notes/move（批量）——必须排在 /api/notes/:id 之前，否则 "move" 会被当成笔记 id
      if (route[0] === "notes" && route.length === 2 && route[1] === "move" && method === "POST") {
        const payload = await readJson(req);
        const ids = Array.isArray(payload.ids) ? payload.ids.map(String).filter(Boolean) : [];
        if (ids.length === 0) throw new HttpError(400, "参数错误：ids 不能为空");
        if (ids.length > 200) throw new HttpError(400, "参数错误：一次最多移动 200 篇");
        // 缺字段不能默认成 null：那等于静默把一批笔记的 group 行删掉（显式传 null 才算移出）
        if (!("group" in payload)) throw new HttpError(400, "参数错误：缺少 group 字段（移出分组请传 null）");
        const group = groupValue(payload.group);

        const moved: string[] = [];
        const failed: Array<{ id: string; reason: string }> = [];
        for (const id of ids) {
          try {
            const row = findNote(id);
            store.setGroup(row.path, group, { baseHash: row.hash ?? undefined });
            reindex(row.path);
            moved.push(id);
          } catch (err) {
            failed.push({
              id,
              reason: err instanceof ConflictError ? "文件已被改动，请刷新后重试" : (err as Error).message,
            });
          }
        }
        // 只有真的移动成功了才登记分组：失败的请求不该凭空多出一个空组
        if (group && moved.length > 0) upsertGroup(dataDir, group);
        sendJson(res, 200, { moved, failed });
        return true;
      }

      // /api/notes/:id/move（单篇）
      if (route[0] === "notes" && route.length === 3 && route[2] === "move" && method === "POST") {
        const payload = await readJson(req);
        if (!("group" in payload)) throw new HttpError(400, "参数错误：缺少 group 字段");
        const group = groupValue(payload.group);
        const baseHash = typeof payload.baseHash === "string" ? payload.baseHash : undefined;
        const row = findNote(route[1]);
        try {
          const moved = store.setGroup(row.path, group, { baseHash });
          if (group) upsertGroup(dataDir, group);
          reindex(row.path);
          sendJson(res, 200, {
            ok: true,
            id: moved.id,
            relPath: moved.relPath,
            hash: moved.hash,
            group: moved.parsed.meta.group ?? null,
          });
        } catch (err) {
          if (err instanceof ConflictError) {
            sendJson(res, 409, {
              error: "文件已被外部改动，请刷新后重试",
              // hash 与 currentHash 都给：move 历史上用 hash，PUT 用 currentHash，前端两边都认
              hash: err.currentHash,
              currentHash: err.currentHash,
              diskUpdated: err.diskUpdated,
            });
            return true;
          }
          throw err;
        }
        return true;
      }

      // /api/notes/:id
      if (route[0] === "notes" && route.length === 2) {
        const id = route[1];
        if (method === "GET") {
          const row = findNote(id);
          const note = store.read(row.path);
          sendJson(res, 200, {
            id: row.id,
            relPath: row.path,
            meta: note.parsed.meta,
            body: note.parsed.body,
            hash: note.hash,
            mtime: note.mtime,
            tags: tagsOf(row.id),
            group: note.parsed.meta.group ?? null,
          });
          return true;
        }
        if (method === "PUT") {
          const payload = await readJson(req);
          const row = findNote(id);
          const body = typeof payload.body === "string" ? payload.body : null;
          const baseHash = typeof payload.baseHash === "string" ? payload.baseHash : "";
          if (body === null) throw new HttpError(400, "缺少 body 字段");
          const patch: { title?: string; tags?: string[] } = {};
          if (typeof payload.title === "string" && payload.title.trim()) patch.title = payload.title.trim();
          if (Array.isArray(payload.tags)) patch.tags = payload.tags.map(String);
          try {
            indexer.ignoreNext(row.path);
            const saved = store.save(row.path, body, baseHash, patch);
            indexer.indexFile(row.path);
            sendJson(res, 200, {
              id: saved.id,
              relPath: saved.relPath,
              hash: saved.hash,
              meta: saved.parsed.meta,
              body: saved.parsed.body,
            });
          } catch (err) {
            if (err instanceof ConflictError) {
              sendJson(res, 409, {
                error: "文件已被外部修改",
                currentHash: err.currentHash,
                diskUpdated: err.diskUpdated,
              });
              return true;
            }
            throw err;
          }
          return true;
        }
        if (method === "DELETE") {
          const row = findNote(id);
          const { name } = store.moveToTrash(row.path);
          indexer.removeFile(row.path);
          sendJson(res, 200, { ok: true, name });
          return true;
        }
      }

      if (route[0] === "search" && route.length === 1 && method === "GET") {
        const q = url.searchParams.get("q") ?? "";
        const tag = url.searchParams.get("tag") ?? undefined;
        const limitRaw = Number(url.searchParams.get("limit") ?? "20");
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 20;
        sendJson(res, 200, { items: search(db, q, { tag, limit }) });
        return true;
      }

      if (route[0] === "backlinks" && route.length === 2 && method === "GET") {
        const id = route[1];
        const row = findNote(id);
        const backlinks = db
          .prepare(
            `SELECT DISTINCT n.id, n.path, n.title FROM links l
               JOIN notes n ON n.id = l.src_id
              WHERE l.target_id = ? OR (l.target_id IS NULL AND l.target_title = ?)`,
          )
          .all(id, row.title) as Array<{ id: string; path: string; title: string }>;
        const outlinks = db
          .prepare("SELECT target_title, target_id FROM links WHERE src_id = ?")
          .all(id) as Array<{ target_title: string; target_id: string | null }>;
        sendJson(res, 200, {
          backlinks: backlinks.map((b) => ({ id: b.id, title: b.title, relPath: b.path })),
          outlinks: outlinks.map((o) => ({
            title: o.target_title,
            targetId: o.target_id,
            resolved: Boolean(o.target_id),
          })),
        });
        return true;
      }

      if (route[0] === "timeline" && route.length === 1 && method === "GET") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        const where: string[] = [];
        const params: string[] = [];
        if (from) {
          where.push("created >= ?");
          params.push(from);
        }
        if (to) {
          where.push("created <= ?");
          params.push(to);
        }
        const rows = db
          .prepare(
            `SELECT id, path, title, type, created, updated FROM notes
              ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
              ORDER BY created DESC, updated DESC LIMIT 2000`,
          )
          .all(...params) as Array<{
          id: string;
          path: string;
          title: string;
          type: string;
          created: string;
          updated: string;
        }>;
        sendJson(res, 200, {
          items: rows.map((r) => ({
            id: r.id,
            relPath: r.path,
            title: r.title,
            type: r.type,
            created: r.created,
            updated: r.updated,
          })),
        });
        return true;
      }

      if (route[0] === "tags" && route.length === 1 && method === "GET") {
        const rows = db
          .prepare("SELECT tag, COUNT(*) AS count FROM tags GROUP BY tag ORDER BY count DESC, tag")
          .all() as Array<{ tag: string; count: number }>;
        sendJson(res, 200, { items: rows });
        return true;
      }

      if (route[0] === "trash" && route.length === 1 && method === "GET") {
        sendJson(res, 200, { items: store.listTrash() });
        return true;
      }

      if (route[0] === "trash" && route.length === 3 && route[2] === "restore" && method === "POST") {
        const restored = store.restore(route[1]);
        reindex(restored.relPath);
        sendJson(res, 200, { ok: true, relPath: restored.relPath });
        return true;
      }

      if (route[0] === "capture" && route.length === 1 && method === "POST") {
        const payload = await readJson(req);
        const text = typeof payload.text === "string" ? payload.text.trim() : "";
        if (!text) throw new HttpError(400, "text 不能为空");
        const note = store.create({
          body: text,
          type: "idea",
          tags: Array.isArray(payload.tags) ? payload.tags.map(String) : undefined,
        });
        reindex(note.relPath);
        sendJson(res, 201, { id: note.id, relPath: note.relPath, title: note.parsed.meta.title });
        return true;
      }

      if (route[0] === "index" && route[1] === "file" && method === "POST") {
        const payload = await readJson(req);
        const relPath = typeof payload.path === "string" ? payload.path : "";
        if (!relPath) throw new HttpError(400, "path 不能为空");
        try {
          indexer.indexFile(relPath);
        } catch (err) {
          throw new HttpError(400, `索引失败：${(err as Error).message}`);
        }
        sendJson(res, 200, { ok: true, path: relPath });
        return true;
      }

      if (route[0] === "reindex" && route.length === 1 && method === "POST") {
        sendJson(res, 200, { ok: true, ...indexer.reindexAll() });
        return true;
      }

      if (route[0] === "config" && route.length === 1) {
        if (method === "GET") {
          sendJson(res, 200, maskConfig(loadAiConfig(dataDir)));
          return true;
        }
        if (method === "PUT") {
          const payload = await readJson(req);
          const patch: Partial<AiConfig> = {};
          if (typeof payload.baseUrl === "string" && payload.baseUrl.trim()) patch.baseUrl = payload.baseUrl.trim();
          if (typeof payload.apiKey === "string" && payload.apiKey.trim()) patch.apiKey = payload.apiKey.trim();
          if (typeof payload.model === "string" && payload.model.trim()) patch.model = payload.model.trim();
          if (typeof payload.temperature === "number") patch.temperature = payload.temperature;
          if (typeof payload.maxTokens === "number") patch.maxTokens = Math.max(256, Math.floor(payload.maxTokens));
          const saved = saveAiConfig(dataDir, patch);
          sendJson(res, 200, maskConfig(saved));
          return true;
        }
      }

      if (route[0] === "ai" && route[1] === "accept" && method === "POST") {
        const payload = await readJson(req);
        const callId = Number(payload.callId);
        if (!Number.isFinite(callId)) throw new HttpError(400, "callId 无效");
        db.prepare("UPDATE ai_calls SET inserted = 1 WHERE id = ?").run(callId);
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (route[0] === "ai" && route.length === 2 && method === "POST") {
        const mode = route[1] as AiMode;
        if (!AI_MODES.includes(mode)) throw new HttpError(404, `未知的 AI 动作：${mode}`);
        const cfg = loadAiConfig(dataDir);
        if (!cfg) {
          sendJson(res, 503, {
            error: "AI 未配置：请在设置里填 baseUrl / model / apiKey",
            code: "AI_UNCONFIGURED",
          });
          return true;
        }
        const payload = await readJson(req);
        let noteTitle = typeof payload.title === "string" ? payload.title : "";
        let noteBody = typeof payload.body === "string" ? payload.body : "";
        let noteId: string | null = null;
        if (typeof payload.noteId === "string" && payload.noteId) {
          const row = findNote(payload.noteId);
          const note = store.read(row.path);
          noteId = row.id;
          noteTitle = note.parsed.meta.title;
          noteBody = note.parsed.body;
        }
        const selection = typeof payload.selection === "string" ? payload.selection : undefined;
        const question = typeof payload.question === "string" ? payload.question : undefined;
        const related = (selection || noteTitle)
          ? search(db, (selection || noteTitle).slice(0, 60), { limit: 4 })
              .filter((hit) => hit.id !== noteId)
              .map((hit) => ({
                title: hit.title,
                excerpt: hit.snippet.replace(/<\/?mark>/g, ""),
              }))
          : [];

        const messages = buildMessages(mode, { noteTitle, noteBody, selection, question, related });
        // 改稿类要输出整篇正文，用用户配的 maxTokens 容易在中途被截断，给一个下限。
        const callCfg = REWRITE_MODES.has(mode)
          ? { ...cfg, maxTokens: Math.max(cfg.maxTokens, 4096) }
          : cfg;
        const callId = Number(
          db
            .prepare(
              "INSERT INTO ai_calls (note_id, mode, model, created, output, inserted) VALUES (?, ?, ?, ?, '', 0)",
            )
            .run(noteId, mode, callCfg.model, toLocalIso((deps.now ?? (() => new Date()))())).lastInsertRowid,
        );

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        // 前端关页面/取消时立刻掐掉上游，不要继续读完并计费
        const controller = new AbortController();
        const onClose = (): void => {
          if (!res.writableEnded) controller.abort();
        };
        res.on("close", onClose);
        let output = "";
        try {
          for await (const delta of streamAi(callCfg, messages, deps.aiFetch, controller.signal)) {
            output += delta;
            res.write(`data: ${JSON.stringify({ delta })}\n\n`);
          }
          db.prepare("UPDATE ai_calls SET output = ? WHERE id = ?").run(output, callId);
          res.write(`event: done\ndata: ${JSON.stringify({ callId })}\n\n`);
          res.end();
        } catch (err) {
          const code = err instanceof AiEmptyError ? "AI_EMPTY" : (err as { code?: string }).code ?? "AI_ERROR";
          const message =
            err instanceof AiEmptyError
              ? "模型没给出正文，换个说法或调大长度（maxTokens）"
              : (err as Error).message;
          if (output) {
            db.prepare("UPDATE ai_calls SET output = ? WHERE id = ?").run(output, callId);
          }
          if (code === "AI_CANCELLED") {
            res.end();
          } else {
            res.write(`event: error\ndata: ${JSON.stringify({ code, message, callId })}\n\n`);
            res.end();
          }
        } finally {
          res.off("close", onClose);
        }
        return true;
      }

      // —— AI 对话助手（agent）——
      if (route[0] === "agent") {
        const providersOf = () => loadProviders(dataDir);
        const readRoots = (): string[] => {
          const section = readSection<{ readRoots?: string[] }>(dataDir, "agent");
          const list = Array.isArray(section.readRoots)
            ? section.readRoots.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
            : [];
          return list.length > 0 ? list : [store.notesRoot];
        };
        const toolsOf = () =>
          createTools({ db, store, notesRoot: store.notesRoot, readRoots: readRoots(), dataDir });
        const chatError = (err: unknown): never => {
          const e = err as ChatError;
          throw new HttpError(e.code === "NOT_FOUND" ? 404 : 400, e.message);
        };
        const chatHttpError = (err: unknown): HttpError => {
          const e = err as ChatError;
          return new HttpError(e.code === "NOT_FOUND" ? 404 : 400, e.message);
        };

        if (route[1] === "providers" && route.length === 2 && method === "GET") {
          sendJson(res, 200, maskProviders(providersOf()));
          return true;
        }

        if (route[1] === "providers" && route.length === 2 && method === "PUT") {
          const payload = await readJson(req);
          saveProviders(dataDir, {
            activeId: typeof payload.activeId === "string" ? payload.activeId : undefined,
            items: Array.isArray(payload.items) ? (payload.items as never[]) : undefined,
          });
          sendJson(res, 200, maskProviders(providersOf()));
          return true;
        }

        if (route[1] === "providers" && route.length === 4 && route[3] === "test" && method === "POST") {
          let runtime;
          try {
            runtime = runtimeOf(providersOf(), route[2]);
          } catch (err) {
            const e = err as { code?: string; message: string };
            sendJson(res, 400, { ok: false, error: e.message, code: e.code ?? "NO_PROVIDER" });
            return true;
          }
          let sample = "";
          try {
            const stream = deps.agentStream ?? streamTurn;
            for await (const event of stream(
              { ...runtime, maxTokens: 64 },
              { system: "你只需回答两个字：可用", messages: [{ role: "user", content: "连通性测试" }], tools: [] },
              deps.aiFetch,
            )) {
              if (event.type === "text") sample += event.delta;
            }
          } catch (err) {
            const e = err as { code?: string; message: string };
            sendJson(res, 502, { ok: false, error: e.message, code: e.code ?? "AI_ERROR" });
            return true;
          }
          sendJson(res, 200, { ok: true, model: runtime.model, sample: sample.slice(0, 60) });
          return true;
        }

        if (route[1] === "chats" && route.length === 2 && method === "GET") {
          sendJson(res, 200, { items: listChats(dataDir) });
          return true;
        }

        if (route[1] === "chats" && route.length === 2 && method === "POST") {
          const payload = await readJson(req);
          const cfg = providersOf();
          const active = cfg.items.find((item) => item.id === cfg.activeId);
          const chat = createChat(dataDir, {
            providerId: typeof payload.providerId === "string" ? payload.providerId : cfg.activeId,
            model: typeof payload.model === "string" ? payload.model : active?.defaultModel ?? "",
          });
          sendJson(res, 201, chat);
          return true;
        }

        if (route[1] === "chats" && route.length === 3) {
          const chatId = route[2];
          if (method === "GET") {
            try {
              sendJson(res, 200, getChat(dataDir, chatId));
            } catch (err) {
              chatError(err);
            }
            return true;
          }
          if (method === "PATCH") {
            const payload = await readJson(req);
            try {
              sendJson(
                res,
                200,
                patchChat(dataDir, chatId, {
                  title: typeof payload.title === "string" ? payload.title : undefined,
                  model: typeof payload.model === "string" ? payload.model : undefined,
                  providerId: typeof payload.providerId === "string" ? payload.providerId : undefined,
                }),
              );
            } catch (err) {
              chatError(err);
            }
            return true;
          }
          if (method === "DELETE") {
            try {
              deleteChat(dataDir, chatId);
              sendJson(res, 200, { ok: true });
            } catch (err) {
              chatError(err);
            }
            return true;
          }
        }

        if (route[1] === "chats" && route.length === 4 && route[3] === "messages" && method === "POST") {
          let chat;
          try {
            chat = getChat(dataDir, route[2]);
          } catch (err) {
            throw chatHttpError(err);
          }
          const payload = await readJson(req);
          const text = typeof payload.text === "string" ? payload.text.trim() : "";
          if (!text) throw new HttpError(400, "消息不能为空");

          let runtime;
          try {
            runtime = runtimeOf(
              providersOf(),
              typeof payload.providerId === "string" ? payload.providerId : chat.providerId,
              typeof payload.model === "string" ? payload.model : chat.model,
            );
          } catch (err) {
            const e = err as { code?: string; message: string };
            sendJson(res, 400, { error: e.message, code: e.code ?? "NO_PROVIDER" });
            return true;
          }

          const session = sseStart(res);
          try {
            await runTurn(
              {
                dataDir,
                chatId: chat.id,
                text,
                tools: toolsOf(),
                runtime,
                fetchImpl: deps.aiFetch,
                signal: session.signal,
                now: deps.now,
                streamTurn: deps.agentStream,
              },
              (event) => session.send(event.type, event),
            );
          } finally {
            await session.close();
          }
          return true;
        }

        if (route[1] === "plans" && route.length === 3 && method === "GET") {
          const found = findPlan(dataDir, route[2]);
          if (!found) throw new HttpError(404, "计划不存在");
          sendJson(res, 200, { chatId: found.chat.id, plan: found.plan });
          return true;
        }

        if (route[1] === "plans" && route.length === 4 && route[3] === "execute" && method === "POST") {
          const found = findPlan(dataDir, route[2]);
          if (!found) throw new HttpError(404, "计划不存在");
          if (found.plan.status !== "pending") throw new HttpError(400, "这批改动已经执行或撤销过了，不能重复执行");
          const payload = await readJson(req);
          const skip = Array.isArray(payload.skip) ? payload.skip.map(Number).filter(Number.isFinite) : [];
          const { results } = executePlan({ store, indexer, dataDir }, found.plan, { skip });
          const plans = found.chat.plans.map((entry) =>
            entry.id === found.plan.id ? { ...entry, status: "executed" as const, results } : entry,
          );
          patchChat(dataDir, found.chat.id, { plans }, { now: deps.now });
          sendJson(res, 200, { ok: true, results });
          return true;
        }

        if (route[1] === "plans" && route.length === 4 && route[3] === "undo" && method === "POST") {
          const found = findPlan(dataDir, route[2]);
          if (!found) throw new HttpError(404, "计划不存在");
          if (found.plan.status !== "executed") throw new HttpError(400, "只有执行过的计划才能撤销");
          const outcome = undoPlan({ store, indexer, dataDir }, found.plan);
          const plans = found.chat.plans.map((entry) =>
            entry.id === found.plan.id ? { ...entry, status: "undone" as const } : entry,
          );
          patchChat(dataDir, found.chat.id, { plans }, { now: deps.now });
          sendJson(res, 200, { ok: true, ...outcome });
          return true;
        }

        if (route[1] === "roots" && route.length === 2) {
          if (method === "GET") {
            sendJson(res, 200, { readRoots: readRoots(), notesRoot: store.notesRoot });
            return true;
          }
          if (method === "PUT") {
            const payload = await readJson(req);
            const list = Array.isArray(payload.readRoots)
              ? payload.readRoots.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
              : [];
            patchSection(dataDir, "agent", { readRoots: list });
            sendJson(res, 200, { readRoots: readRoots(), notesRoot: store.notesRoot });
            return true;
          }
        }

        throw new HttpError(404, `未知的 agent 接口：${url.pathname}`);
      }

      // —— 备份（通用 WebDAV）——
      if (route[0] === "backup") {
        const backup = deps.backup;
        if (!backup) throw new HttpError(503, "备份服务未启用");

        if (route.length === 1 && method === "GET") {
          sendJson(res, 200, backup.status());
          return true;
        }

        if (route.length === 1 && method === "POST") {
          try {
            const result = await backup.run();
            sendJson(res, 200, result);
          } catch (err) {
            const info = describeWebdavError(err);
            sendJson(res, info.code === "UNCONFIGURED" ? 400 : 502, {
              error: info.message,
              code: info.code,
            });
          }
          return true;
        }

        if (route[1] === "config" && method === "GET") {
          sendJson(res, 200, maskBackupConfig(loadBackupConfig(dataDir)));
          return true;
        }

        if (route[1] === "config" && method === "PUT") {
          const payload = await readJson(req);
          const cfg = saveBackupConfig(dataDir, {
            url: typeof payload.url === "string" ? payload.url.trim() : undefined,
            account: typeof payload.account === "string" ? payload.account.trim() : undefined,
            remoteRoot: typeof payload.remoteRoot === "string" ? payload.remoteRoot.trim() : undefined,
            intervalMinutes: payload.intervalMinutes as number | undefined,
            keepDays: payload.keepDays as number | undefined,
            password: typeof payload.password === "string" ? payload.password : undefined,
          });
          backup.invalidate();
          sendJson(res, 200, maskBackupConfig(cfg));
          return true;
        }

        if (route[1] === "test" && method === "POST") {
          try {
            await backup.test();
            sendJson(res, 200, { ok: true });
          } catch (err) {
            const info = describeWebdavError(err);
            sendJson(res, info.code === "UNCONFIGURED" ? 400 : 502, { error: info.message, code: info.code });
          }
          return true;
        }

        if (route[1] === "snapshots" && route.length === 2 && method === "GET") {
          sendJson(res, 200, { items: backup.listSnapshots() });
          return true;
        }

        if (route[1] === "snapshots" && route.length === 3 && method === "GET") {
          const day = route[2];
          sendJson(res, 200, { day, items: backup.snapshotFiles(day) });
          return true;
        }

        if (route[1] === "snapshots" && route.length === 4 && route[3] === "file" && method === "GET") {
          const day = route[2];
          const relPath = url.searchParams.get("path") ?? "";
          try {
            const content = await backup.readSnapshotFile(day, relPath);
            if (content === null) throw new HttpError(404, "快照里没有这个文件");
            sendJson(res, 200, { day, path: relPath, content });
          } catch (err) {
            const info = describeWebdavError(err);
            if (info.code === "BAD_REQUEST") throw new HttpError(400, info.message);
            sendJson(res, 502, { error: info.message, code: info.code });
          }
          return true;
        }

        if (route[1] === "restore" && route.length === 2 && method === "POST") {
          const payload = await readJson(req);
          const day = typeof payload.day === "string" ? payload.day : "";
          const relPath = typeof payload.relPath === "string" ? payload.relPath : "";
          const baseHash = typeof payload.baseHash === "string" ? payload.baseHash : undefined;
          if (!day || !relPath) throw new HttpError(400, "缺少 day 或 relPath");
          let content: string | null;
          try {
            content = await backup.readSnapshotFile(day, relPath);
          } catch (err) {
            const info = describeWebdavError(err);
            if (info.code === "BAD_REQUEST") throw new HttpError(400, info.message);
            sendJson(res, 502, { error: info.message, code: info.code });
            return true;
          }
          if (content === null) throw new HttpError(404, "快照里没有这个文件");
          // 「本地原本有没有这篇」决定前端提示语：没有就是"按原路径复活"
          let existed = true;
          try {
            store.read(relPath);
          } catch {
            existed = false;
          }
          try {
            indexer.ignoreNext(relPath);
            const restored = store.restoreFromSnapshot(relPath, content, baseHash);
            indexer.indexFile(relPath);
            sendJson(res, 200, {
              ok: true,
              created: !existed,
              id: restored.id,
              relPath: restored.relPath,
              hash: restored.hash,
              meta: restored.parsed.meta,
            });
          } catch (err) {
            if (err instanceof ConflictError) {
              sendJson(res, 409, {
                error: "文件已被外部修改",
                currentHash: err.currentHash,
                diskUpdated: err.diskUpdated,
              });
              return true;
            }
            throw err;
          }
          return true;
        }
      }

      // /api/groups
      if (route[0] === "groups" && route.length === 1) {
        if (method === "GET") {
          sendJson(res, 200, groupsOverview(groupsDeps));
          return true;
        }
        if (method === "POST") {
          const body = await readJson(req);
          const name = typeof body.name === "string" ? body.name : "";
          sendJson(res, 200, createGroup(groupsDeps, name));
          return true;
        }
      }

      // /api/groups/:name
      if (route[0] === "groups" && route.length === 2) {
        const name = route[1];
        if (method === "PATCH") {
          const body = await readJson(req);
          const next = typeof body.name === "string" ? body.name : "";
          sendJson(res, 200, renameGroup(groupsDeps, name, next));
          return true;
        }
        if (method === "DELETE") {
          sendJson(res, 200, deleteGroup(groupsDeps, name));
          return true;
        }
      }

      return false;
    } catch (err) {
      if (err instanceof GroupsHttpError) {
        sendJson(res, err.status, { error: err.message });
        return true;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
        return true;
      }
      sendJson(res, 500, { error: (err as Error).message });
      return true;
    }
  };
}
