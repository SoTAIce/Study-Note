#!/usr/bin/env node
/**
 * study-notes 的 DSH 连接线：手写、零 npm 依赖的 stdio MCP JSON-RPC 服务器。
 *
 * 传输：stdin/stdout 行分隔 JSON-RPC 2.0（每行一个 JSON 对象）。
 * 协议：initialize / tools/list / tools/call；通知（没有 id）一律忽略、不回应。
 *
 * 设计边界（见 docs/superpowers/specs/2026-10-30-study-notes-design.md §6.8）：
 * - 只写 data/notes/**\/*.md，绝不直接写 data/index.db；
 * - 写完 .md 后尝试 POST {STUDY_API}/api/index/file，让 App 进程（索引的唯一写者）
 *   重建该文件的索引；App 没在跑就静默失败，等下次启动全量扫描补齐。
 *
 * 直接运行：node dsh-mcp/server.mjs
 * 进程内测试：import { createSession } from "./dsh-mcp/server.mjs"
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { NoteStore, toLocalIso } from "../server/store.ts";
import { excerpt } from "../server/parse.ts";

const DEFAULT_ROOT = "D:\\work\\study-notes";
const DEFAULT_INDEX_URL = "http://127.0.0.1:7777/api/index/file";
const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "study-notes", version: "0.1.0" };
const INDEX_TIMEOUT_MS = 3000;
const SNIPPET_RADIUS = 30;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/** tools/list 的静态定义。handlers 与之一一对应。 */
const TOOL_LIST = [
  {
    name: "notes_search",
    description:
      "在本地学习笔记里全文检索（中文两字查询也支持）。返回命中笔记的 id、标题、相对路径与命中词两侧的片段。",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "检索词。≥3 字符走 FTS5 trigram 短语匹配，1-2 字符走 LIKE 匹配。",
        },
        limit: {
          type: "integer",
          description: `返回条数上限，默认 ${DEFAULT_LIMIT}，最大 ${MAX_LIMIT}`,
          minimum: 1,
          maximum: MAX_LIMIT,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "notes_read",
    description:
      "读一条笔记：返回 frontmatter 摘要（id/标题/类型/时间/标签）与 Markdown 正文。id 或 path 至少给一个；path 是相对 data/notes 的路径。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "笔记 id（来自 notes_search / notes_create）" },
        path: {
          type: "string",
          description: "相对 data/notes 的路径，例如 inbox/2026-10-30-想法.md",
        },
      },
      anyOf: [{ required: ["id"] }, { required: ["path"] }],
      additionalProperties: false,
    },
  },
  {
    name: "notes_create",
    description:
      "新建一条 Markdown 笔记。只写 .md 文件；索引由 App 的 watcher 或 /api/index/file 补齐。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "标题；留空时用正文前若干字推导" },
        body: { type: "string", description: "Markdown 正文" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "标签列表（正文里的 #标签 也会自动收录）",
        },
        type: {
          type: "string",
          enum: ["note", "idea", "source"],
          description: "笔记类型，默认 note；idea 会落到 inbox/",
        },
        group: {
          type: "string",
          description: "所属分组（例如「Go 学习」）；不填就是未分组",
        },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "notes_append",
    description:
      "把一段文字追加到已有笔记末尾，自动加「### 本地时间」小标题。不改动原有正文。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "笔记 id" },
        path: { type: "string", description: "相对 data/notes 的路径" },
        text: { type: "string", description: "要追加的 Markdown 文本" },
      },
      required: ["text"],
      anyOf: [{ required: ["id"] }, { required: ["path"] }],
      additionalProperties: false,
    },
  },
  {
    name: "notes_capture",
    description: "快速捕获一条想法：建一条 type=idea 的笔记，落在 data/notes/inbox/ 下。",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "想法正文" },
        tags: { type: "array", items: { type: "string" }, description: "标签列表" },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
];

function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}

function jsonResult(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function jsonError(id, code, message) {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

/** 本地时间（到分钟），例如 2026-10-30 15:20。 */
function localStamp(date) {
  return toLocalIso(date).slice(0, 16).replace("T", " ");
}

function normalizeLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(n)));
}

/** 命中词两侧各取 radius 个字符；命中词不在正文里（只命中标题）时退回正文摘要。 */
function makeSnippet(body, query, radius = SNIPPET_RADIUS) {
  const text = String(body ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  const needle = String(query ?? "");
  const idx = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (idx < 0) return excerpt(text, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + needle.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function formatSearchResult(query, hits) {
  if (hits.length === 0) return `没有找到与「${query}」相关的笔记。`;
  const blocks = hits.map((hit, index) => {
    const lines = [`${index + 1}. ${hit.title || "（未命名）"}  [id: ${hit.id}]`];
    if (hit.relPath) lines.push(`   path: ${hit.relPath}`);
    const snippet = makeSnippet(hit.body, query);
    if (snippet) lines.push(`   ${snippet}`);
    return lines.join("\n");
  });
  return `找到 ${hits.length} 条与「${query}」相关的笔记：\n\n${blocks.join("\n\n")}`;
}

function formatNote(note) {
  const meta = note.parsed.meta;
  const lines = [
    `# ${meta.title}`,
    "",
    `id: ${note.id}`,
    `path: ${note.relPath}`,
    `type: ${meta.type}`,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    `tags: ${meta.tags.length > 0 ? meta.tags.join(", ") : "（无）"}`,
  ];
  if (meta.group) lines.push(`group: ${meta.group}`);
  if (meta.source) lines.push(`source: ${meta.source}`);
  lines.push("", "---", "", note.parsed.body);
  return lines.join("\n");
}

/**
 * 创建一个 MCP 会话（纯进程内，不碰 stdin/stdout）。
 * @param {{
 *   root?: string, dataDir?: string, notesDir?: string, dbFile?: string,
 *   indexUrl?: string, now?: () => Date, fetchImpl?: typeof fetch,
 * }} [opts]
 * @returns {{ handle(line: string): Promise<string | null> }}
 */
export function createSession(opts = {}) {
  const root = path.resolve(opts.root ?? process.env.STUDY_NOTES_DIR ?? DEFAULT_ROOT);
  const dataDir = path.resolve(opts.dataDir ?? process.env.STUDY_DATA ?? path.join(root, "data"));
  const notesRoot = path.resolve(
    opts.notesDir ?? opts.notesRoot ?? path.join(dataDir, "notes"),
  );
  const dbFile = path.resolve(opts.dbFile ?? path.join(dataDir, "index.db"));
  const indexUrl = opts.indexUrl ?? DEFAULT_INDEX_URL;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const clock = opts.now ?? (() => new Date());

  const store = new NoteStore({
    notesRoot,
    historyDir: path.join(dataDir, ".history"),
    trashDir: path.join(dataDir, ".trash"),
    now: clock,
  });

  /** 请 App 进程重建这一条文件的索引；App 没在跑就静默失败（索引可丢，启动时全量扫描会补齐）。 */
  async function notifyApp(relPath) {
    if (!indexUrl || typeof fetchImpl !== "function") return;
    try {
      const res = await fetchImpl(indexUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: relPath }),
        signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
      });
      await res.text().catch(() => "");
    } catch {
      // 静默：App 没启动 / /api/index/file 还没实现 / 超时
    }
  }

  /** 只读打开索引库：MCP 永远不写 index.db。不存在或打不开时返回 null。 */
  function openIndex() {
    if (!fs.existsSync(dbFile)) return null;
    try {
      return new DatabaseSync(dbFile, { readOnly: true });
    } catch {
      return null;
    }
  }

  function normalizeRelPath(rawPath) {
    const unified = rawPath.trim().replace(/\\/g, "/");
    // Windows 绝对路径（D:/...）交给 NoteStore 做越界校验；相对路径去掉开头的 /
    return /^[A-Za-z]:/.test(unified) ? unified : unified.replace(/^\/+/, "");
  }

  /** id 走索引库换 relPath；path 直接用。 */
  function relPathFromArgs(args) {
    const rawPath = typeof args.path === "string" ? args.path.trim() : "";
    if (rawPath) return normalizeRelPath(rawPath);

    const id = typeof args.id === "string" ? args.id.trim() : "";
    if (!id) throw new Error("需要 id 或 path 参数");

    const db = openIndex();
    if (!db) {
      throw new Error(`索引不可用，无法按 id 定位笔记（id: ${id}）；请改用 path 参数`);
    }
    try {
      const row = db.prepare("SELECT path FROM notes WHERE id = ?").get(id);
      if (!row || !row.path) throw new Error(`索引里没有 id 为 ${id} 的笔记`);
      return row.path;
    } finally {
      db.close();
    }
  }

  function searchRows(db, query, limit) {
    if (Array.from(query).length >= 3) {
      try {
        const phrase = `"${query.replace(/"/g, '""')}"`;
        return db
          .prepare("SELECT note_id AS id, title, body FROM notes_fts WHERE notes_fts MATCH ? LIMIT ?")
          .all(phrase, limit);
      } catch {
        // trigram 分词器对某些标点会报错，退回 LIKE
      }
    }
    const like = `%${query}%`;
    return db
      .prepare(
        "SELECT note_id AS id, title, body FROM notes_fts WHERE title LIKE ? OR body LIKE ? LIMIT ?",
      )
      .all(like, like, limit);
  }

  function searchNotes(query, limit) {
    const db = openIndex();
    if (!db) {
      return "索引还没建立（data/index.db 不存在）。MCP 只写 .md，索引由 App 的 watcher 或 /api/index/file 补齐：请先启动 App（或调用 /api/reindex）再搜。";
    }
    try {
      const rows = searchRows(db, query, limit);
      const pathStmt = db.prepare("SELECT path FROM notes WHERE id = ?");
      const hits = rows.map((row) => {
        const record = pathStmt.get(row.id);
        return { id: row.id, title: row.title, body: row.body, relPath: record?.path ?? "" };
      });
      return formatSearchResult(query, hits);
    } finally {
      db.close();
    }
  }

  const handlers = {
    async notes_search(args) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) throw new Error("query 不能为空");
      return searchNotes(query, normalizeLimit(args.limit));
    },

    async notes_read(args) {
      const relPath = relPathFromArgs(args);
      return formatNote(store.read(relPath));
    },

    async notes_create(args) {
      const body = typeof args.body === "string" ? args.body : "";
      if (!body.trim()) throw new Error("body 不能为空");
      const tags = Array.isArray(args.tags)
        ? args.tags.filter((tag) => typeof tag === "string")
        : [];
      const type = args.type === "idea" || args.type === "source" ? args.type : "note";
      const group = typeof args.group === "string" && args.group.trim() ? args.group.trim() : undefined;
      const note = store.create({
        title: typeof args.title === "string" ? args.title : "",
        body,
        tags,
        type,
        ...(group ? { group } : {}),
      });
      await notifyApp(note.relPath);
      const groupLine = note.parsed.meta.group ? `\ngroup: ${note.parsed.meta.group}` : "";
      return `已创建笔记：${note.parsed.meta.title}\nid: ${note.id}\npath: ${note.relPath}${groupLine}`;
    },

    async notes_append(args) {
      const relPath = relPathFromArgs(args);
      const text = typeof args.text === "string" ? args.text : "";
      if (!text.trim()) throw new Error("text 不能为空");
      const current = store.read(relPath);
      const stamp = localStamp(clock());
      const body = `${current.parsed.body}\n\n### ${stamp}\n${text}\n`;
      const saved = store.save(relPath, body, current.hash);
      await notifyApp(saved.relPath);
      return `已追加到「${saved.parsed.meta.title}」\nid: ${saved.id}\npath: ${saved.relPath}\n小标题: ### ${stamp}`;
    },

    async notes_capture(args) {
      const text = typeof args.text === "string" ? args.text : "";
      if (!text.trim()) throw new Error("text 不能为空");
      const tags = Array.isArray(args.tags)
        ? args.tags.filter((tag) => typeof tag === "string")
        : [];
      const note = store.create({ body: text, tags, type: "idea" });
      await notifyApp(note.relPath);
      return `已收进 inbox：${note.parsed.meta.title}\nid: ${note.id}\npath: ${note.relPath}`;
    },
  };

  /** 处理一行 JSON-RPC。返回要写回 stdout 的一行 JSON；通知/空行返回 null。 */
  async function handle(line) {
    const raw = typeof line === "string" ? line.trim() : String(line ?? "").trim();
    if (!raw) return null;

    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return jsonError(null, -32700, "Parse error");
    }

    if (Array.isArray(message)) {
      return jsonError(null, -32600, "Invalid Request: 不支持 JSON-RPC 批量请求");
    }
    if (!message || typeof message !== "object" || typeof message.method !== "string") {
      const id = message && typeof message === "object" ? message.id : null;
      if (id === undefined || id === null) return null;
      return jsonError(id, -32600, "Invalid Request");
    }

    const id = message.id;
    // 通知（没有 id）一律忽略、不回应
    if (id === undefined || id === null) return null;

    const params =
      message.params && typeof message.params === "object" && !Array.isArray(message.params)
        ? message.params
        : {};

    try {
      switch (message.method) {
        case "initialize":
          return jsonResult(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { ...SERVER_INFO },
          });
        case "ping":
          return jsonResult(id, {});
        case "tools/list":
          return jsonResult(id, { tools: TOOL_LIST });
        case "tools/call": {
          const name = typeof params.name === "string" ? params.name : "";
          const args =
            params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
              ? params.arguments
              : {};
          const handler = handlers[name];
          if (!handler) {
            return jsonResult(id, {
              content: [{ type: "text", text: `未知工具：${name || "（空）"}` }],
              isError: true,
            });
          }
          try {
            const text = await handler(args);
            return jsonResult(id, { content: [{ type: "text", text }] });
          } catch (err) {
            return jsonResult(id, {
              content: [{ type: "text", text: errorText(err) }],
              isError: true,
            });
          }
        }
        default:
          return jsonError(id, -32601, `Method not found: ${message.method}`);
      }
    } catch (err) {
      return jsonError(id, -32603, `Internal error: ${errorText(err)}`);
    }
  }

  return { handle };
}

/** 直接执行时：stdin 逐行读，stdout 逐行写；按到达顺序串行处理，保证响应不乱序。 */
function startStdio() {
  const session = createSession();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();

  rl.on("line", (line) => {
    queue = queue
      .then(async () => {
        const output = await session.handle(line);
        if (output !== null && output !== undefined) process.stdout.write(`${output}\n`);
      })
      .catch((err) => {
        process.stderr.write(`[study-notes-mcp] ${errorText(err)}\n`);
      });
  });

  rl.on("close", () => {
    queue.finally(() => {
      process.exit(0);
    });
  });
}

const entry = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : "";
const self = fileURLToPath(import.meta.url).toLowerCase();
if (entry && entry === self) startStdio();
