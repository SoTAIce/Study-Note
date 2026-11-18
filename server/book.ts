/**
 * 连读（book-001）：一个分组（通常是子项目 `agent/looprun`）里的笔记按「目录笔记」的链接顺序连成一本。
 *
 * - 目录笔记：组里 `type: index` 的那篇（多篇取最早创建的）；没有时，标题正好是「目录」的那篇也算。
 * - 章节顺序：目录正文里 [[链接]] 第一次出现的顺序；重复、指向目录自己的忽略。
 * - 链接到别的分组的笔记照样是一章（foreign: true）；找不到的标题占一个「还没有这篇」的位置。
 * - 组里没写进目录的笔记放在 unlisted；没有目录时按创建时间连读。
 *
 * 只读数据库找「有哪些笔记」，正文一律从 store 读（Markdown 是唯一真源）。
 * 设计：docs/superpowers/specs/2026-11-18-project-book-view-design.md
 */
import type { DatabaseSync } from "node:sqlite";
import { normalizeGroupName, sameGroup, validateGroupName } from "./groups.ts";
import { extractLinks } from "./parse.ts";
import { ConflictError, type NoteStore } from "./store.ts";

export const INDEX_TITLE = "目录";

export class BookHttpError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export type BookNote = {
  id: string;
  title: string;
  path: string;
  group: string | null;
  created: string;
  body: string;
  hash: string;
};

export type BookChapter =
  | ({ kind: "note"; foreign: boolean } & BookNote)
  | { kind: "missing"; title: string };

export type Book = {
  group: string;
  index: BookNote | null;
  chapters: BookChapter[];
  /** 组里没写进目录的笔记（按创建时间）；没有目录时恒为空 */
  unlisted: BookNote[];
  /** 组里另外几篇也是目录（没被采用），给连读顶部提示用 */
  otherIndexes: string[];
};

type Row = { id: string; path: string; title: string; type: string; created: string; group: string | null };

// ---- 纯函数（有单测） ----

/** 目录正文里的章节标题：按出现顺序、去重，忽略指向目录自己的链接。 */
export function indexLinkTitles(body: string, selfTitle: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const link of extractLinks(body)) {
    const title = link.title.trim();
    if (!title || title === selfTitle.trim() || seen.has(title)) continue;
    seen.add(title);
    out.push(title);
  }
  return out;
}

/** 从组里的笔记挑出目录：type index 优先（最早创建），其次标题叫「目录」的。 */
export function pickIndex<T extends { type: string; title: string; created: string }>(
  rows: T[],
): { index: T | null; others: T[] } {
  const byCreated = [...rows].sort((a, b) => a.created.localeCompare(b.created));
  const typed = byCreated.filter((row) => row.type === "index");
  if (typed.length > 0) return { index: typed[0], others: typed.slice(1) };
  const named = byCreated.find((row) => row.title.trim() === INDEX_TITLE);
  return { index: named ?? null, others: [] };
}

/** 生成目录正文：一行一个链接。 */
export function indexBody(titles: string[]): string {
  return titles.map((title) => `- [[${title}]]`).join("\n") + (titles.length ? "\n" : "");
}

/** 在目录正文末尾追加链接，沿用原文的换行符；已经在目录里的不重复加。 */
export function appendIndexLinks(body: string, titles: string[], selfTitle: string): string {
  const existing = new Set(indexLinkTitles(body, selfTitle));
  const fresh = titles.filter((title, i) => title.trim() && !existing.has(title) && titles.indexOf(title) === i);
  if (fresh.length === 0) return body;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = fresh.map((title) => `- [[${title}]]`).join(eol);
  if (!body.trim()) return lines + eol;
  const trimmed = body.replace(/(\r?\n)+$/, "");
  return `${trimmed}${eol}${lines}${eol}`;
}

/** 目录里一行的列表前缀：`  - `、`* `、`3. ` 之类；不是列表项返回 null。 */
function listPrefix(line: string): { indent: string; marker: string } | null {
  const m = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line);
  if (!m) return null;
  const marker = /^\d/.test(m[2]) ? `${Number.parseInt(m[2], 10) + 1}${m[2].slice(-1)}` : m[2];
  return { indent: m[1], marker };
}

/**
 * 「在此后新建一章」（book-002）：把 `[[title]]` 插在目录里第一次链到 `afterTitle` 的那一行之后，
 * 沿用那一行的缩进和列表符号（有序列表序号 +1，后面的序号不动，Markdown 渲染照样连续）。
 * 找不到 `afterTitle`（或没给）就追加到末尾；已经在目录里的不重复加。
 */
export function insertIndexLinkAfter(body: string, afterTitle: string | null, title: string, selfTitle: string): string {
  if (indexLinkTitles(body, selfTitle).includes(title)) return body;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);
  const after = afterTitle?.trim() ?? "";
  const at = after
    ? lines.findIndex((line) => extractLinks(line).some((link) => link.title.trim() === after))
    : -1;
  if (at < 0) return appendIndexLinks(body, [title], selfTitle);
  const prefix = listPrefix(lines[at]);
  const line = prefix ? `${prefix.indent}${prefix.marker} [[${title}]]` : `- [[${title}]]`;
  lines.splice(at + 1, 0, line);
  return lines.join(eol);
}

/** 新章节标题：要能放进 [[链接]]，所以不能有 ] | # 和换行 */
function chapterTitle(raw: unknown): string {
  const title = typeof raw === "string" ? raw.trim() : "";
  if (!title) throw new BookHttpError(400, "参数错误：需要 title");
  if (/[\]\[|#\r\n]/.test(title)) throw new BookHttpError(400, "标题里不能有 [ ] | # 或换行（会弄坏目录里的链接）");
  if (title.length > 120) throw new BookHttpError(400, "标题太长了（最多 120 字）");
  return title;
}

// ---- 接口 ----

export type BookDeps = {
  db: DatabaseSync;
  store: NoteStore;
  reindex: (relPath: string) => void;
};

function groupParam(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new BookHttpError(400, "参数错误：需要 group");
  const check = validateGroupName(raw);
  if (!check.ok) throw new BookHttpError(400, `参数错误：${check.error}`);
  return check.name;
}

export function createBookRoutes(deps: BookDeps) {
  const { db, store } = deps;

  function projectRows(group: string): Row[] {
    return db
      .prepare(
        `SELECT id, path, title, type, created, group_name AS "group" FROM notes
          WHERE lower(group_name) = lower(?) ORDER BY created, path`,
      )
      .all(normalizeGroupName(group)) as unknown as Row[];
  }

  function load(row: Row): BookNote | null {
    try {
      const note = store.read(row.path);
      return {
        id: row.id,
        title: row.title,
        path: row.path,
        group: row.group ?? null,
        created: row.created,
        body: note.parsed.body,
        hash: note.hash,
      };
    } catch {
      // 索引里有、磁盘上没了（外部刚删）：当作找不到
      return null;
    }
  }

  /** 按标题找笔记：本组的优先，其次全库最早创建的那篇（与双链一样按标题精确匹配）。 */
  function resolve(title: string, project: Row[]): Row | null {
    const own = project.find((row) => row.title === title);
    if (own) return own;
    const row = db
      .prepare(
        `SELECT id, path, title, type, created, group_name AS "group" FROM notes
          WHERE title = ? ORDER BY created, path LIMIT 1`,
      )
      .get(title) as unknown as Row | undefined;
    return row ?? null;
  }

  function buildBook(group: string): Book {
    const project = projectRows(group);
    const { index: indexRow, others } = pickIndex(project);
    const index = indexRow ? load(indexRow) : null;

    if (!indexRow || !index) {
      const chapters = project.map(load).filter((note): note is BookNote => note !== null);
      return {
        group,
        index: null,
        chapters: chapters.map((note) => ({ kind: "note" as const, foreign: false, ...note })),
        unlisted: [],
        otherIndexes: [],
      };
    }

    const used = new Set<string>([index.id]);
    const chapters: BookChapter[] = [];
    for (const title of indexLinkTitles(index.body, index.title)) {
      const row = resolve(title, project);
      if (!row) {
        chapters.push({ kind: "missing", title });
        continue;
      }
      if (used.has(row.id)) continue;
      const note = load(row);
      if (!note) {
        chapters.push({ kind: "missing", title });
        continue;
      }
      used.add(row.id);
      chapters.push({ kind: "note", foreign: !sameGroup(row.group, group), ...note });
    }

    const otherIds = new Set(others.map((row) => row.id));
    const unlisted = project
      .filter((row) => !used.has(row.id) && !otherIds.has(row.id))
      .map(load)
      .filter((note): note is BookNote => note !== null);

    return { group, index, chapters, unlisted, otherIndexes: others.map((row) => row.title) };
  }

  /**
   * 生成目录 / 往目录里追加章节。
   * - 组里还没有目录：新建一篇 `type: index` 的「<子项目名> 目录」，写入 titles（缺省 = 组里全部笔记，按创建时间）。
   * - 已有目录：在末尾追加 titles（必填），带 baseHash 防止覆盖刚改过的目录。
   */
  function writeIndex(payload: Record<string, unknown>): { index: { id: string; hash: string }; created: boolean } {
    const group = groupParam(payload.group);
    const titles = Array.isArray(payload.titles)
      ? payload.titles.filter((title): title is string => typeof title === "string" && title.trim() !== "")
      : null;
    const project = projectRows(group);
    const { index } = pickIndex(project);

    if (!index) {
      const list = titles ?? project.map((row) => row.title);
      const leaf = group.includes("/") ? group.slice(group.indexOf("/") + 1) : group;
      const note = store.create({
        title: `${leaf} ${INDEX_TITLE}`,
        type: "index",
        group,
        body: indexBody(list),
      });
      deps.reindex(note.relPath);
      return { index: { id: note.id, hash: note.hash }, created: true };
    }

    if (!titles || titles.length === 0) throw new BookHttpError(400, "参数错误：已有目录时需要 titles");
    const baseHash = typeof payload.baseHash === "string" ? payload.baseHash : "";
    if (!baseHash) throw new BookHttpError(400, "参数错误：需要 baseHash");
    const current = store.read(index.path);
    const next = appendIndexLinks(current.parsed.body, titles, index.title);
    try {
      const saved = store.save(index.path, next, baseHash);
      deps.reindex(index.path);
      return { index: { id: index.id, hash: saved.hash }, created: false };
    } catch (err) {
      if (err instanceof ConflictError) {
        throw new BookHttpError(409, "目录刚被改过，请刷新后再试", { currentHash: current.hash });
      }
      throw err;
    }
  }

  /**
   * 在此后新建一章：先建笔记（归入该组），再在目录里 `after` 那一章之后插入链接；没有目录就先生成一篇。
   * 两次写入：目录那次冲突时笔记已经建好，返回 409 并带上新笔记，界面说明「笔记已建好，目录没改上」。
   */
  function createChapter(payload: Record<string, unknown>): {
    note: { id: string; hash: string; title: string };
    index: { id: string; hash: string; created: boolean };
  } {
    const group = groupParam(payload.group);
    const title = chapterTitle(payload.title);
    const project = projectRows(group);
    if (project.some((row) => row.title.trim() === title)) {
      throw new BookHttpError(400, `这个项目里已经有《${title}》了`);
    }
    const afterId = typeof payload.after === "string" && payload.after ? payload.after : null;
    const afterRow = afterId
      ? ((db.prepare(`SELECT title FROM notes WHERE id = ?`).get(afterId) as { title: string } | undefined) ?? null)
      : null;
    if (afterId && !afterRow) throw new BookHttpError(400, "参数错误：after 指向的笔记不存在");
    const { index } = pickIndex(project);
    if (index && index.title.trim() === title) throw new BookHttpError(400, "新章节不能和目录同名");
    const baseHash = typeof payload.baseHash === "string" && payload.baseHash ? payload.baseHash : null;

    const created = store.create({ title, type: "note", group, body: `# ${title}\n` });
    deps.reindex(created.relPath);
    const note = { id: created.id, hash: created.hash, title };

    if (!index) {
      const leaf = group.includes("/") ? group.slice(group.indexOf("/") + 1) : group;
      const indexTitle = `${leaf} ${INDEX_TITLE}`;
      const body = insertIndexLinkAfter(indexBody(project.map((row) => row.title)), afterRow?.title ?? null, title, indexTitle);
      const made = store.create({ title: indexTitle, type: "index", group, body });
      deps.reindex(made.relPath);
      return { note, index: { id: made.id, hash: made.hash, created: true } };
    }

    const current = store.read(index.path);
    const next = insertIndexLinkAfter(current.parsed.body, afterRow?.title ?? null, title, index.title);
    try {
      const saved = store.save(index.path, next, baseHash ?? current.hash);
      deps.reindex(index.path);
      return { note, index: { id: index.id, hash: saved.hash, created: false } };
    } catch (err) {
      if (err instanceof ConflictError) {
        throw new BookHttpError(409, `《${title}》已建好，但目录刚被改过，没插进去；刷新后点「加入目录」`, {
          currentHash: current.hash,
          note,
        });
      }
      throw err;
    }
  }

  return async function handle(
    method: string,
    route: string[],
    url: URL,
    body: () => Promise<Record<string, unknown>>,
  ): Promise<unknown | undefined> {
    if (route[0] !== "book") return undefined;
    if (route.length === 1 && method === "GET") return buildBook(groupParam(url.searchParams.get("group")));
    if (route.length === 2 && route[1] === "index" && method === "POST") return writeIndex(await body());
    if (route.length === 2 && route[1] === "chapters" && method === "POST") return createChapter(await body());
    return undefined;
  };
}
