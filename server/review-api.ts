/**
 * 知识简卡接口（srs-001）：
 * - GET  /api/cards                卡片墙（筛选：group / tag / note / q；排序 sort=recent|due|weak）
 * - GET  /api/review/queue         今日复习队列（同样的筛选），每张带四档打分后的到期时间
 * - GET  /api/review/summary       全局今日到期数（左栏、首页用）
 * - POST /api/review/grade         { card, grade }
 * - POST /api/review/undo          { card }
 * - GET / PUT /api/review/settings { newPerDay }
 */
import type { DatabaseSync } from "node:sqlite";
import { readSection, patchSection } from "./config.ts";
import { mastery, preview, type Grade } from "./fsrs.ts";
import { buildQueue, type ReviewLog } from "./review.ts";
import { groupFilterSql } from "./groups.ts";

export class ReviewHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const DEFAULT_NEW_PER_DAY = 20;
export const MAX_NEW_PER_DAY = 200;

type CardRow = {
  id: string;
  note_id: string;
  ord: number;
  kind: string;
  title: string;
  body: string;
  line: number;
  path: string;
  note_title: string;
  group_name: string | null;
};

export type ReviewDeps = { db: DatabaseSync; log: ReviewLog; dataDir: string; now?: () => number };

type Filters = { group?: string; tag?: string; note?: string; q?: string };

function filtersFrom(url: URL): Filters {
  const get = (k: string) => url.searchParams.get(k)?.trim() || undefined;
  return { group: get("group"), tag: get("tag"), note: get("note"), q: get("q") };
}

export function readNewPerDay(dataDir: string): number {
  const value = readSection<{ newPerDay: number }>(dataDir, "review").newPerDay;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_NEW_PER_DAY
    ? value
    : DEFAULT_NEW_PER_DAY;
}

export function createReviewRoutes(deps: ReviewDeps) {
  const { db, log, dataDir } = deps;
  const now = deps.now ?? (() => Date.now());

  function rows(f: Filters): CardRow[] {
    const where: string[] = [];
    const params: string[] = [];
    if (f.group === "none") where.push("n.group_name IS NULL");
    else if (f.group) {
      const filter = groupFilterSql("n.group_name", f.group);
      where.push(filter.sql);
      params.push(...filter.params);
    }
    if (f.tag) {
      where.push("EXISTS (SELECT 1 FROM tags t WHERE t.note_id = n.id AND t.tag = ?)");
      params.push(f.tag);
    }
    if (f.note) {
      where.push("c.note_id = ?");
      params.push(f.note);
    }
    if (f.q) {
      const pattern = `%${f.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      where.push("(c.title LIKE ? ESCAPE '\\' OR c.body LIKE ? ESCAPE '\\' OR n.title LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern, pattern);
    }
    return db
      .prepare(
        `SELECT c.id, c.note_id, c.ord, c.kind, c.title, c.body, c.line, n.path, n.title AS note_title, n.group_name
           FROM cards c JOIN notes n ON n.id = c.note_id
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY n.updated DESC, n.path, c.ord`,
      )
      .all(...params) as CardRow[];
  }

  function view(row: CardRow) {
    const state = log.stateOf(row.id);
    return {
      id: row.id,
      noteId: row.note_id,
      notePath: row.path,
      noteTitle: row.note_title,
      group: row.group_name,
      kind: row.kind,
      title: row.title,
      body: row.body,
      line: row.line,
      mastery: mastery(state),
      due: state ? state.due : null,
      stability: state ? state.stability : null,
      reps: state?.reps ?? 0,
      lapses: state?.lapses ?? 0,
    };
  }

  function counts(all: CardRow[]) {
    const { due, fresh } = buildQueue(log, all, { newPerDay: readNewPerDay(dataDir) });
    return { total: all.length, due, fresh, tomorrow: log.dueTomorrow(all.map((r) => r.id)) };
  }

  return async function handle(
    method: string,
    route: string[],
    url: URL,
    body: () => Promise<Record<string, unknown>>,
  ): Promise<unknown | undefined> {
    if (route[0] === "cards" && route.length === 1 && method === "GET") {
      const all = rows(filtersFrom(url));
      const sort = url.searchParams.get("sort") ?? "recent";
      let items = all.map(view);
      if (sort === "due") {
        items = [...items].sort((a, b) => (a.due ?? Infinity) - (b.due ?? Infinity));
      } else if (sort === "weak") {
        items = [...items].sort((a, b) => (a.stability ?? -1) - (b.stability ?? -1));
      }
      return { items, ...counts(all) };
    }

    if (route[0] !== "review") return undefined;

    if (route[1] === "summary" && route.length === 2 && method === "GET") {
      return counts(rows({}));
    }

    if (route[1] === "queue" && route.length === 2 && method === "GET") {
      const all = rows(filtersFrom(url));
      const newPerDay = readNewPerDay(dataDir);
      const { queue, due, fresh } = buildQueue(log, all, { newPerDay });
      const at = now();
      const items = queue.map((row) => {
        const p = preview(log.stateOf(row.id), at);
        return { ...view(row), next: { 1: p[1].due, 2: p[2].due, 3: p[3].due, 4: p[4].due } };
      });
      return { items, due, fresh, newPerDay, total: all.length };
    }

    if (route[1] === "grade" && route.length === 2 && method === "POST") {
      const input = await body();
      const card = typeof input.card === "string" ? input.card : "";
      const grade = input.grade;
      if (grade !== 1 && grade !== 2 && grade !== 3 && grade !== 4) throw new ReviewHttpError(400, "grade 只能是 1~4");
      const row = db.prepare("SELECT note_id FROM cards WHERE id = ?").get(card) as { note_id: string } | undefined;
      if (!row) throw new ReviewHttpError(404, "这张简卡不存在（可能刚被改掉或删掉）");
      const state = log.grade(card, row.note_id, grade as Grade);
      return { ok: true, due: state.due, mastery: mastery(state) };
    }

    if (route[1] === "undo" && route.length === 2 && method === "POST") {
      const input = await body();
      const card = typeof input.card === "string" ? input.card : "";
      if (!card) throw new ReviewHttpError(400, "缺少 card");
      return { ok: log.undo(card) };
    }

    if (route[1] === "settings" && route.length === 2) {
      if (method === "GET") return { newPerDay: readNewPerDay(dataDir) };
      if (method === "PUT") {
        const input = await body();
        const value = input.newPerDay;
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_NEW_PER_DAY) {
          throw new ReviewHttpError(400, `newPerDay 要是 0~${MAX_NEW_PER_DAY} 的整数`);
        }
        patchSection(dataDir, "review", { newPerDay: value });
        return { newPerDay: value };
      }
    }
    return undefined;
  };
}
