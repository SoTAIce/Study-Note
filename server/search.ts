import type { DatabaseSync } from "node:sqlite";

export type SearchHit = {
  id: string;
  relPath: string;
  title: string;
  snippet: string;
  score: number;
  updated: string;
};

type CandidateRow = {
  id: string;
  path: string;
  title: string;
  updated: string;
  body: string;
};

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
 * 候选集：≥3 字符走 FTS5 trigram（中英文都能子串匹配），不足 3 字符走 LIKE 兜底。
 * FTS 的 bm25 只用于预筛，最终排序在这里重新加权。
 */
function candidateIds(db: DatabaseSync, needle: string): string[] {
  const ids: string[] = [];
  if (charLength(needle) >= 3) {
    const phrase = `"${needle.replace(/"/g, '""')}"`;
    try {
      const rows = db
        .prepare("SELECT note_id AS id FROM notes_fts WHERE notes_fts MATCH ?")
        .all(phrase) as Array<{ id: string }>;
      for (const row of rows) ids.push(row.id);
    } catch {
      // trigram 解析不了的查询直接落回 LIKE
    }
  }
  if (ids.length === 0) {
    const pattern = likePattern(needle);
    const rows = db
      .prepare(
        "SELECT note_id AS id FROM notes_fts WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'",
      )
      .all(pattern, pattern) as Array<{ id: string }>;
    for (const row of rows) ids.push(row.id);
  }
  return [...new Set(ids)];
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
  const ids = candidateIds(db, needle);
  if (ids.length === 0) return [];

  const noteStmt = db.prepare(
    `SELECT n.id AS id, n.path AS path, n.title AS title, n.updated AS updated, f.body AS body
       FROM notes n JOIN notes_fts f ON f.note_id = n.id
      WHERE n.id = ?`,
  );
  const tagStmt = db.prepare("SELECT tag FROM tags WHERE note_id = ?");
  const lowerNeedle = needle.toLowerCase();
  const recentCutoff = now.getTime() - RECENT_DAYS * 24 * 60 * 60 * 1000;

  const hits: SearchHit[] = [];
  for (const id of ids) {
    const row = noteStmt.get(id) as CandidateRow | undefined;
    if (!row) continue;
    const tags = (tagStmt.all(id) as Array<{ tag: string }>).map((t) => t.tag);
    if (opts.tag && !tags.includes(opts.tag)) continue;

    const titleHit = row.title.toLowerCase().includes(lowerNeedle);
    const tagHit = tags.some((tag) => tag.toLowerCase().includes(lowerNeedle));
    let score = titleHit ? 3 : tagHit ? 2 : 1;
    if (tagHit && titleHit) score = 3;
    const updatedAt = Date.parse(row.updated);
    if (!Number.isNaN(updatedAt) && updatedAt >= recentCutoff) score *= 1.2;

    hits.push({
      id: row.id,
      relPath: row.path,
      title: row.title,
      snippet: makeSnippet(row.body, needle),
      score: Number(score.toFixed(3)),
      updated: row.updated,
    });
  }

  hits.sort((a, b) => b.score - a.score || b.updated.localeCompare(a.updated));
  return hits.slice(0, limit);
}
