import type { DatabaseSync } from "node:sqlite";

export type SearchHit = {
  id: string;
  relPath: string;
  title: string;
  snippet: string;
  score: number;
  updated: string;
};

/** 候选行：只带打分要用的字段，正文等排完序再按 rowid 取 */
type CandidateRow = {
  fts_rowid: number;
  id: string;
  path: string;
  title: string;
  updated: string;
  /** 该笔记的标签，用 \x1f 连接（没有标签时为 null） */
  tags: string | null;
};

const TAG_SEP = "\x1f";

const RECENT_DAYS = 7;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function likePattern(needle: string): string {
  return `%${needle.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function charLength(text: string): number {
  return [...text].length;
}

/**
 * 候选集（一次查询）：≥3 字符走 FTS5 trigram（中英文都能子串匹配），不足 3 字符或 FTS 没结果时走 LIKE 兜底。
 * 同一条 SQL 里带出标题、更新时间和标签（标签筛选也在 SQL 里做），不取正文——正文只给最终要显示的几条取。
 */
function candidates(db: DatabaseSync, needle: string, tag: string | undefined): CandidateRow[] {
  const select = `SELECT f.rowid AS fts_rowid, n.id AS id, n.path AS path, n.title AS title, n.updated AS updated,
            (SELECT group_concat(t.tag, char(31)) FROM tags t WHERE t.note_id = n.id) AS tags
       FROM notes_fts f JOIN notes n ON n.id = f.note_id`;
  const tagWhere = tag ? " AND EXISTS (SELECT 1 FROM tags t2 WHERE t2.note_id = n.id AND t2.tag = ?)" : "";
  const tagParams = tag ? [tag] : [];

  if (charLength(needle) >= 3) {
    const phrase = `"${needle.replace(/"/g, '""')}"`;
    try {
      const rows = db.prepare(`${select} WHERE notes_fts MATCH ?${tagWhere}`).all(phrase, ...tagParams) as CandidateRow[];
      if (rows.length > 0) return rows;
    } catch {
      // trigram 解析不了的查询直接落回 LIKE
    }
  }
  const pattern = likePattern(needle);
  return db
    .prepare(`${select} WHERE (f.title LIKE ? ESCAPE '\\' OR f.body LIKE ? ESCAPE '\\')${tagWhere}`)
    .all(pattern, pattern, ...tagParams) as CandidateRow[];
}

function makeSnippet(body: string, needle: string, radius = 30): string {
  const index = body.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) {
    const head = body.slice(0, radius * 2).trim();
    return escapeHtml(head) + (body.length > head.length ? "…" : "");
  }
  const start = Math.max(0, index - radius);
  const end = Math.min(body.length, index + needle.length + radius);
  const before = body.slice(start, index);
  const match = body.slice(index, index + needle.length);
  const after = body.slice(index + needle.length, end);
  return `${start > 0 ? "…" : ""}${escapeHtml(before)}<mark>${escapeHtml(match)}</mark>${escapeHtml(after)}${end < body.length ? "…" : ""}`;
}

export function search(
  db: DatabaseSync,
  q: string,
  opts: { tag?: string; limit?: number; now?: Date } = {},
): SearchHit[] {
  const needle = q.trim();
  if (!needle) return [];
  const limit = opts.limit ?? 20;
  const now = opts.now ?? new Date();
  const rows = candidates(db, needle, opts.tag);
  if (rows.length === 0) return [];

  const lowerNeedle = needle.toLowerCase();
  const recentCutoff = now.getTime() - RECENT_DAYS * 24 * 60 * 60 * 1000;

  // 先打分、排序、截断（只用标题 / 标签 / 时间），再给留下的几条取正文做片段
  const seen = new Set<string>();
  const scored: Array<{ row: CandidateRow; score: number }> = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const tags = row.tags ? row.tags.split(TAG_SEP) : [];
    const titleHit = row.title.toLowerCase().includes(lowerNeedle);
    const tagHit = tags.some((t) => t.toLowerCase().includes(lowerNeedle));
    let score = titleHit ? 3 : tagHit ? 2 : 1;
    const updatedAt = Date.parse(row.updated);
    if (!Number.isNaN(updatedAt) && updatedAt >= recentCutoff) score *= 1.2;
    scored.push({ row, score: Number(score.toFixed(3)) });
  }
  scored.sort((a, b) => b.score - a.score || b.row.updated.localeCompare(a.row.updated));

  const bodyStmt = db.prepare("SELECT body FROM notes_fts WHERE rowid = ?");
  return scored.slice(0, limit).map(({ row, score }) => {
    const body = (bodyStmt.get(row.fts_rowid) as { body: string } | undefined)?.body ?? "";
    return {
      id: row.id,
      relPath: row.path,
      title: row.title,
      snippet: makeSnippet(body, needle),
      score,
      updated: row.updated,
    };
  });
}
