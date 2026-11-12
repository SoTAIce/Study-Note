import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { NoteStore } from "./store.ts";
import { search } from "./search.ts";
import type { ToolSpec } from "./providers/types.ts";

/** 工具层错误：带上 code，便于测试与上层区分"模型参数错"和"库坏了"。 */
export class ToolError extends Error {
  readonly code: "BAD_PATH" | "NOT_FOUND" | "TOO_LARGE" | "BAD_ARG";

  constructor(code: ToolError["code"], message: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

const MAX_NOTE_BODY = 40_000;
const MAX_FILE_BYTES = 200_000;
const DEFAULT_READ_LINES = 400;
const IGNORED_DIRS = new Set(["node_modules", ".git", ".svn", "bin", "obj", "dist", ".venv", "__pycache__", ".superpowers"]);

/**
 * Windows 上 `fs.realpathSync` **不解析目录 junction**，只有 `.native` 会解析到真实目标。
 * 白名单校验必须用 native 版本，否则笔记库里放一个 junction 就能把 AI 引到白名单外面去。
 */
function realOf(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return fs.realpathSync(target);
  }
}

function isInside(realRoot: string, realTarget: string): boolean {
  const rel = path.relative(realRoot, realTarget);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function resolveInside(root: string, rel: string): string {
  if (typeof rel !== "string" || !rel.trim()) throw new ToolError("BAD_ARG", "路径为空");
  if (rel.includes("\0")) throw new ToolError("BAD_PATH", "路径含非法字符");
  // 非 Windows 平台上 "C:\\x" / "\\\\host\\share" 会被当成相对文件名，这里统一按越界拒绝
  if (!path.isAbsolute(rel) && path.win32.isAbsolute(rel)) throw new ToolError("BAD_PATH", `路径越界：${rel}`);
  const base = path.resolve(root);
  const target = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(base, rel);
  if (!isInside(base, target)) throw new ToolError("BAD_PATH", `路径越界：${rel}`);
  // 词法上在库内还不够：junction / 符号链接会让真实位置跑到库外
  const realBase = realOf(base);
  const realTarget = fs.existsSync(target) ? realOf(target) : realOf(path.dirname(target));
  const candidate = fs.existsSync(target) ? realTarget : path.join(realTarget, path.basename(target));
  if (!isInside(realBase, candidate)) throw new ToolError("BAD_PATH", `路径越界（链接）：${rel}`);
  return target;
}

/** 在多个白名单根里找一个能容纳 target 的（笔记库之外要显式加白名单才读得到）。 */
function resolveWithinRoots(roots: string[], target: string, denyReal?: string[]): string {
  const resolved = path.resolve(target);
  const realTarget = fs.existsSync(resolved) ? realOf(resolved) : realOf(path.dirname(resolved));
  const candidate = fs.existsSync(resolved) ? realTarget : path.join(realTarget, path.basename(resolved));

  // 自己的 data/ 目录永远不给读：里面是 config.json（明文 key）、会话记录、历史快照
  for (const denied of denyReal ?? []) {
    if (isInside(denied, candidate)) throw new ToolError("BAD_PATH", `这个目录不许读：${target}`);
  }

  for (const root of roots) {
    const realBase = realOf(path.resolve(root));
    if (isInside(realBase, candidate)) return resolved;
  }
  throw new ToolError("BAD_PATH", `不在允许读取的目录里：${target}`);
}

export const PROPOSE_PLAN_SPEC: ToolSpec = {
  name: "propose_plan",
  description:
    "提交一次笔记改动计划供用户审批。这是唯一能修改笔记的方式；调用后本轮结束，由用户决定是否执行。一次最多 20 个动作。",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "一句话说明这批改动要达成什么，用户会先看到它" },
      ops: {
        type: "array",
        description: "要执行的动作",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["create", "append", "rewrite", "trash"] },
            path: { type: "string", description: "笔记库内的相对路径，必须以 .md 结尾" },
            title: { type: "string", description: "create 时的标题" },
            body: { type: "string", description: "create/rewrite 时的完整 Markdown 正文" },
            text: { type: "string", description: "append 时要追加的文字" },
            tags: { type: "array", items: { type: "string" } },
            type: { type: "string", enum: ["note", "idea", "source"] },
            group: {
              type: "string",
              description: "这篇笔记归到哪个分组（create/append/rewrite 可用）。用户没明确说科目就别填。",
            },
          },
          required: ["kind"],
        },
      },
    },
    required: ["summary", "ops"],
  },
};

type ToolResult = { content: string; summary: string };

export type Tools = {
  specs: ToolSpec[];
  run(name: string, args: unknown): Promise<ToolResult>;
  /** 计划规范化需要的依赖（与工具同一套路径，避免两处各配一次） */
  planDeps: { store: NoteStore; notesRoot: string };
};

export function createTools(deps: {
  db: DatabaseSync;
  store: NoteStore;
  notesRoot: string;
  readRoots: string[];
  /** 应用自己的数据目录：无论白名单怎么配，都不许 AI 读它（config.json 里有明文 key） */
  dataDir?: string;
  now?: () => Date;
}): Tools {
  // 笔记库永远在可读范围内：用户加了别的目录，不该反过来把笔记本身关掉
  const roots = Array.from(new Set([deps.notesRoot, ...deps.readRoots]));
  const denyReal = deps.dataDir ? [realOf(deps.dataDir)] : [];

  const specs: ToolSpec[] = [
    {
      name: "list_notes",
      description: "列出笔记库里的笔记（可按标签/类型过滤），用于了解库里有什么。",
      parameters: {
        type: "object",
        properties: {
          tag: { type: "string", description: "只列出带该标签的笔记" },
          type: { type: "string", enum: ["note", "idea", "source"] },
          group: { type: "string", description: "只列出该分组的笔记；传 none 表示未分组" },
          limit: { type: "number", description: "最多返回多少条，默认 50" },
        },
      },
    },
    {
      name: "search_notes",
      description: "全文搜索笔记库正文（支持中文）。改笔记前先用它确认现状。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索词" },
          limit: { type: "number", description: "默认 10，最多 30" },
        },
        required: ["query"],
      },
    },
    {
      name: "read_note",
      description: "读一篇笔记的完整正文与元信息。修改前必须先读。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "笔记库内相对路径" } },
        required: ["path"],
      },
    },
    {
      name: "read_dir",
      description: "列出一个目录的文件树（仅在允许读取的目录内），常用于看源码结构。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对笔记库或白名单根目录的路径" },
          depth: { type: "number", description: "深度，1 或 2，默认 1" },
        },
        required: ["path"],
      },
    },
    {
      name: "read_file",
      description: "按行读一个文本文件（仅在允许读取的目录内，单次最多 200KB）。读源码用。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number", description: "起始行，从 1 开始" },
          limit: { type: "number", description: "行数，默认 400" },
        },
        required: ["path"],
      },
    },
  ];

  async function run(name: string, rawArgs: unknown): Promise<ToolResult> {
    try {
      const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
      switch (name) {
        case "list_notes":
          return listNotes(args);
        case "search_notes":
          return searchNotes(args);
        case "read_note":
          return readNote(args);
        case "read_dir":
          return readDir(args);
        case "read_file":
          return readFile(args);
        default:
          return { content: `错误：没有这个工具 ${name}`, summary: `未知工具 ${name}` };
      }
    } catch (err) {
      const toolErr = err as ToolError;
      const message = toolErr instanceof ToolError ? toolErr.message : (err as Error).message;
      return { content: `错误：${message}`, summary: `${name} 失败：${message}` };
    }
  }

  function listNotes(args: Record<string, unknown>): ToolResult {
    const limit = clamp(Number(args.limit ?? 50), 1, 200);
    const type = typeof args.type === "string" ? args.type : undefined;
    const tag = typeof args.tag === "string" ? args.tag : undefined;
    const rawGroup = typeof args.group === "string" && args.group.trim() ? args.group.trim() : undefined;
    // `none` 是「未分组」的哨兵，大小写都算
    const group = rawGroup && rawGroup.toLowerCase() === "none" ? "none" : rawGroup;
    const rows = deps.db
      .prepare(
        `SELECT n.path AS path, n.title AS title, n.type AS type, n.updated AS updated,
                n.group_name AS "group"
           FROM notes n
          WHERE (?1 IS NULL OR n.type = ?1)
            AND (?2 IS NULL OR EXISTS (SELECT 1 FROM tags t WHERE t.note_id = n.id AND lower(t.tag) = lower(?2)))
            AND (?4 IS NULL
                 OR (?4 = 'none' AND (n.group_name IS NULL OR n.group_name = ''))
                 OR (?4 <> 'none' AND lower(n.group_name) = lower(?4)))
          ORDER BY n.updated DESC
          LIMIT ?3`,
      )
      .all(type ?? null, tag ?? null, limit, group ?? null) as Array<{
      path: string;
      title: string | null;
      type: string | null;
      updated: string;
      group: string | null;
    }>;
    const tagStmt = deps.db.prepare(
      "SELECT t.tag AS tag FROM tags t JOIN notes n ON n.id = t.note_id WHERE n.path = ?",
    );
    const items = rows.map((row) => ({
      path: row.path,
      title: row.title ?? path.basename(row.path, ".md"),
      type: row.type ?? "note",
      updated: row.updated,
      group: row.group ?? null,
      tags: (tagStmt.all(row.path) as Array<{ tag: string }>).map((entry) => entry.tag),
    }));
    return { content: JSON.stringify(items), summary: `${items.length} 篇笔记` };
  }

  function searchNotes(args: Record<string, unknown>): ToolResult {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) return { content: "参数错误：缺少 query", summary: "缺少 query" };
    const limit = clamp(Number(args.limit ?? 10), 1, 30);
    const hits = search(deps.db, query, { limit }).map((hit) => ({
      path: hit.relPath,
      title: hit.title,
      snippet: hit.snippet,
      updated: hit.updated,
    }));
    return { content: JSON.stringify(hits), summary: `搜索「${query}」命中 ${hits.length} 篇` };
  }

  function readNote(args: Record<string, unknown>): ToolResult {
    const rel = typeof args.path === "string" ? args.path.trim() : "";
    if (!rel) return { content: "参数错误：缺少 path", summary: "缺少 path" };
    const safe = resolveInside(deps.notesRoot, rel);
    let note;
    try {
      note = deps.store.read(path.relative(deps.notesRoot, safe).split(path.sep).join("/"));
    } catch {
      throw new ToolError("NOT_FOUND", `笔记不存在：${rel}`);
    }
    const parsed = note.parsed as {
      meta?: Record<string, unknown>;
      title?: string;
      tags?: string[];
      created?: string;
      body?: string;
    };
    let body = parsed.body ?? "";
    let truncated = false;
    if (body.length > MAX_NOTE_BODY) {
      body = `${body.slice(0, MAX_NOTE_BODY)}\n\n〔已截断：原文 ${parsed.body!.length} 字，只给了前 ${MAX_NOTE_BODY} 字〕`;
      truncated = true;
    }
    const payload = {
      path: note.relPath,
      title: parsed.title ?? path.basename(note.relPath, ".md"),
      tags: parsed.tags ?? [],
      created: parsed.created ?? note.parsed.meta?.created ?? "",
      updated: note.mtime,
      hash: note.hash,
      group: parsed.meta?.group ?? null,
      body,
    };
    return {
      content: JSON.stringify(payload),
      summary: `${payload.title} · ${body.length} 字${truncated ? "（已截断）" : ""}`,
    };
  }

  function readDir(args: Record<string, unknown>): ToolResult {
    const rel = typeof args.path === "string" ? args.path.trim() : "";
    if (!rel) return { content: "参数错误：缺少 path", summary: "缺少 path" };
    const depth = clamp(Number(args.depth ?? 1), 1, 2);
    const abs = resolveWithinRoots(roots, resolveCandidate(rel), denyReal);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      throw new ToolError("NOT_FOUND", `目录不存在：${rel}`);
    }
    const guard = (real: string) => {
      for (const denied of denyReal) {
        if (isInside(denied, real)) return false;
      }
      return roots.some((root) => isInside(realOf(path.resolve(root)), real));
    };
    const tree = walk(realOf(abs), depth, 1, guard);
    return { content: JSON.stringify({ root: abs, entries: tree }), summary: `${rel}：${countEntries(tree)} 项` };
  }

  function readFile(args: Record<string, unknown>): ToolResult {
    const rel = typeof args.path === "string" ? args.path.trim() : "";
    if (!rel) return { content: "参数错误：缺少 path", summary: "缺少 path" };
    const offset = Math.max(1, Math.trunc(Number(args.offset ?? 1)) || 1);
    const limit = clamp(Number(args.limit ?? DEFAULT_READ_LINES), 1, 2000);
    const abs = resolveWithinRoots(roots, resolveCandidate(rel), denyReal);
    const stat = fs.statSync(abs, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) throw new ToolError("NOT_FOUND", `文件不存在：${rel}`);
    if (stat.size > MAX_FILE_BYTES * 5) throw new ToolError("TOO_LARGE", `文件太大（${stat.size} 字节），请用 offset/limit 分段读`);
    const raw = fs.readFileSync(abs);
    if (raw.includes(0)) throw new ToolError("BAD_ARG", "这是二进制文件，读不了");
    const all = raw.toString("utf8").split(/\r?\n/);
    const slice = all.slice(offset - 1, offset - 1 + limit);
    const content = slice.join("\n").slice(0, MAX_FILE_BYTES);
    return {
      content,
      summary: `${path.basename(abs)} 第 ${offset}-${offset + slice.length - 1} 行（共 ${all.length} 行）`,
    };
  }

  /** 相对路径先按笔记库解析，再让白名单校验兜底；绝对路径直接交给白名单。 */
  function resolveCandidate(rel: string): string {
    if (path.isAbsolute(rel)) return rel;
    const inNotes = path.resolve(deps.notesRoot, rel);
    if (fs.existsSync(inNotes)) return inNotes;
    return path.resolve(roots[0] ?? deps.notesRoot, rel);
  }

  return { specs, run, planDeps: { store: deps.store, notesRoot: deps.notesRoot } };
}

function walk(
  dir: string,
  depth: number,
  current: number = 1,
  guard?: (target: string) => boolean,
): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith(".") && name !== ".") {
      if (name !== ".git") continue;
    }
    if (IGNORED_DIRS.has(name)) continue;
    const abs = path.join(dir, name);
    let stat: fs.Stats;
    let real: string;
    try {
      stat = fs.statSync(abs);
      real = realOf(abs);
    } catch {
      continue;
    }
    // 目录里可能有 junction/符号链接：真实位置必须还在白名单内，否则整条跳过
    if (guard && !guard(real)) continue;
    if (stat.isDirectory()) {
      entries.push({
        name,
        kind: "dir",
        ...(current < depth ? { children: walk(real, depth, current + 1, guard) } : {}),
      });
    } else {
      entries.push({ name, kind: "file", size: stat.size });
    }
  }
  return entries;
}

function countEntries(entries: Array<Record<string, unknown>>): number {
  let total = 0;
  for (const entry of entries) {
    total += 1;
    const children = entry.children as Array<Record<string, unknown>> | undefined;
    if (children) total += countEntries(children);
  }
  return total;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
