/**
 * 复习记录（srs-001）：`data/review/log.jsonl` 是真源，只追加。
 *
 * 一行一个事件：
 * - 打分 `{"t":"…","card":"c_…","note":"…","grade":3}`
 * - 撤回 `{"t":"…","undo":"c_…"}`（撤掉这张卡最近一次还没撤的打分）
 * - 别名 `{"t":"…","alias":"c_新","of":"c_旧"}`（改了标题的卡认回原卡）
 * 启动时从头重放，按 FSRS 算出每张卡的状态放在内存里；SQLite 不存复习状态，删了索引也不丢。
 */
import fs from "node:fs";
import path from "node:path";
import { review, type CardState, type Grade } from "./fsrs.ts";
import { toLocalIso } from "./store.ts";

type GradeEvent = { t: string; card: string; note: string; grade: Grade };
type UndoEvent = { t: string; undo: string };
type AliasEvent = { t: string; alias: string; of: string };
type LogEvent = GradeEvent | UndoEvent | AliasEvent;

type Entry = { at: number; grade: Grade; card: string };

export const REVIEW_DIR = "review";
export const REVIEW_LOG = "log.jsonl";
/** 每天最多复习的旧卡数 */
export const MAX_REVIEWS_PER_DAY = 200;

export function reviewLogPath(dataDir: string): string {
  return path.join(dataDir, REVIEW_DIR, REVIEW_LOG);
}

function isGrade(value: unknown): value is Grade {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

/** 本地时区的今天 0 点 */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export class ReviewLog {
  private readonly file: string;
  private readonly now: () => number;
  /** 新 id → 旧 id */
  private readonly aliases = new Map<string, string>();
  /** 规范 id → 有效的打分（按时间） */
  private readonly entries = new Map<string, Entry[]>();
  private readonly states = new Map<string, CardState>();
  skipped = 0;

  constructor(deps: { dataDir: string; now?: () => number }) {
    this.file = reviewLogPath(deps.dataDir);
    this.now = deps.now ?? (() => Date.now());
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    const raw = fs.readFileSync(this.file, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let event: LogEvent;
      try {
        event = JSON.parse(line) as LogEvent;
      } catch {
        this.skipped += 1;
        continue;
      }
      this.apply(event, false);
    }
    for (const id of this.entries.keys()) this.recompute(id);
    if (this.skipped > 0) console.warn(`[review] 复习日志里有 ${this.skipped} 行读不了，已跳过`);
  }

  /** 顺着别名找到最早的那张卡（防环） */
  canonical(id: string): string {
    let cur = id;
    const seen = new Set<string>();
    while (this.aliases.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = this.aliases.get(cur) as string;
    }
    return cur;
  }

  private apply(event: LogEvent, recompute: boolean): void {
    const at = Date.parse(event.t);
    if ("alias" in event) {
      if (typeof event.alias === "string" && typeof event.of === "string" && this.canonical(event.of) !== event.alias) {
        this.aliases.set(event.alias, event.of);
        // 新 id 下已经有的记录并到旧卡上
        const moved = this.entries.get(event.alias);
        if (moved) {
          this.entries.delete(event.alias);
          this.states.delete(event.alias);
          const root = this.canonical(event.of);
          const list = [...(this.entries.get(root) ?? []), ...moved].sort((a, b) => a.at - b.at);
          this.entries.set(root, list);
          if (recompute) this.recompute(root);
        }
      } else {
        this.skipped += 1;
      }
      return;
    }
    if ("undo" in event) {
      const root = this.canonical(String(event.undo));
      const list = this.entries.get(root);
      if (list && list.length > 0) {
        list.pop();
        if (list.length === 0) this.entries.delete(root);
        if (recompute) this.recompute(root);
      }
      return;
    }
    if (typeof event.card !== "string" || !isGrade(event.grade) || Number.isNaN(at)) {
      this.skipped += 1;
      return;
    }
    const root = this.canonical(event.card);
    const list = this.entries.get(root) ?? [];
    list.push({ at, grade: event.grade, card: event.card });
    this.entries.set(root, list);
    if (recompute) this.recompute(root);
  }

  private recompute(root: string): void {
    const list = this.entries.get(root);
    if (!list || list.length === 0) {
      this.states.delete(root);
      return;
    }
    let state: CardState | null = null;
    for (const entry of list) state = review(state, entry.grade, entry.at);
    this.states.set(root, state as CardState);
  }

  private append(event: LogEvent): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");
    this.apply(event, true);
  }

  stateOf(cardId: string): CardState | null {
    return this.states.get(this.canonical(cardId)) ?? null;
  }

  grade(cardId: string, noteId: string, grade: Grade): CardState {
    if (!isGrade(grade)) throw new Error("grade 只能是 1~4");
    this.append({ t: toLocalIso(new Date(this.now())), card: cardId, note: noteId, grade });
    return this.stateOf(cardId) as CardState;
  }

  /** 撤回这张卡最近一次打分；没有可撤的返回 false */
  undo(cardId: string): boolean {
    const list = this.entries.get(this.canonical(cardId));
    if (!list || list.length === 0) return false;
    this.append({ t: toLocalIso(new Date(this.now())), undo: cardId });
    return true;
  }

  /** 改了标题的卡认回原卡（已经是同一张就不记） */
  alias(newId: string, oldId: string): void {
    if (newId === oldId || this.canonical(newId) === this.canonical(oldId)) return;
    this.append({ t: toLocalIso(new Date(this.now())), alias: newId, of: oldId });
  }

  /** 今天已经学了几张新卡、复习了几张旧卡 */
  today(): { newDone: number; reviewsDone: number } {
    const start = startOfDay(this.now());
    let newDone = 0;
    let reviewsDone = 0;
    for (const list of this.entries.values()) {
      const first = list[0];
      if (first.at >= start) {
        newDone += 1;
        continue;
      }
      if (list.some((e) => e.at >= start)) reviewsDone += 1;
    }
    return { newDone, reviewsDone };
  }

  /** 到期：在今天结束前到期的都算（学习中的 10 分钟卡也在内） */
  isDue(state: CardState): boolean {
    return state.due < startOfDay(this.now()) + 86_400_000;
  }
}

export type QueueCard<T> = T & { id: string };

/**
 * 今日复习队列：先到期的旧卡（按到期时间），再新卡（按给定顺序），各自受每日上限约束。
 */
export function buildQueue<T extends { id: string }>(
  log: ReviewLog,
  cards: T[],
  limits: { newPerDay: number; maxReviews?: number },
): { queue: T[]; due: number; fresh: number } {
  const { newDone, reviewsDone } = log.today();
  const due: Array<{ card: T; at: number }> = [];
  const fresh: T[] = [];
  for (const card of cards) {
    const state = log.stateOf(card.id);
    if (!state) fresh.push(card);
    else if (log.isDue(state)) due.push({ card, at: state.due });
  }
  due.sort((a, b) => a.at - b.at);
  const reviewLeft = Math.max(0, (limits.maxReviews ?? MAX_REVIEWS_PER_DAY) - reviewsDone);
  const newLeft = Math.max(0, limits.newPerDay - newDone);
  const dueCards = due.slice(0, reviewLeft).map((d) => d.card);
  const newCards = fresh.slice(0, newLeft);
  return { queue: [...dueCards, ...newCards], due: dueCards.length, fresh: newCards.length };
}
