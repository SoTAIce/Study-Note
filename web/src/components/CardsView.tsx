import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api.ts";
import type { TagCount } from "../api.ts";
import { dueLabel, formatSpan, GRADE_LABEL, MASTERY_LABEL } from "../lib/review-format.ts";
import * as review from "../review-api.ts";
import type { CardFilters, CardSort, Grade, KCard, QueueCard } from "../review-api.ts";
import Icon from "./Icon.tsx";
import Preview from "./Preview.tsx";

/**
 * 知识简卡（srs-001）：卡片墙 + 今日复习。
 * 卡片墙按分组 / 标签 / 关键字筛选浏览；「今日复习」按当前筛选出队列，翻面回想、打分。
 */

/** 外部要求打开的样子：从首页 / 快捷键直接开始复习，从右栏「复习这篇」带上笔记 */
export type CardsIntent = { review: boolean; note?: { id: string; title: string }; seq: number };

type Props = {
  groups: string[];
  tags: TagCount[];
  intent: CardsIntent;
  onOpenNote: (id: string) => void;
  onOpenWikilink: (title: string) => void;
  /** 打分 / 撤回后通知外面刷新到期数 */
  onChanged: () => void;
};

const SORT_LABEL: Record<CardSort, string> = { recent: "最近添加", due: "快到期", weak: "最不熟" };
const NEW_PER_DAY_OPTIONS = [0, 5, 10, 20, 30, 50, 100];

export default function CardsView({ groups, tags, intent, onOpenNote, onOpenWikilink, onChanged }: Props) {
  const [filters, setFilters] = useState<CardFilters>(() => (intent.note ? { note: intent.note.id } : {}));
  const [noteTitle, setNoteTitle] = useState<string | null>(intent.note?.title ?? null);
  const [sort, setSort] = useState<CardSort>("recent");
  const [items, setItems] = useState<KCard[] | null>(null);
  const [counts, setCounts] = useState<review.ReviewCounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(intent.review);
  const [newPerDay, setNewPerDay] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const seq = useRef(0);

  // 外部再次要求（例如又按了 Ctrl+Shift+R、右栏换了一篇）时重设
  useEffect(() => {
    setFilters(intent.note ? { note: intent.note.id } : {});
    setNoteTitle(intent.note?.title ?? null);
    setSearch("");
    setReviewing(intent.review);
  }, [intent]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setError(null);
    try {
      const res = await review.listCards(filters, sort);
      if (mine !== seq.current) return;
      setItems(res.items);
      setCounts({ total: res.total, due: res.due, fresh: res.fresh, tomorrow: res.tomorrow });
    } catch (err) {
      if (mine === seq.current) setError(api.errorMessage(err));
    }
  }, [filters, sort]);

  useEffect(() => {
    if (!reviewing) void load();
  }, [load, reviewing]);

  useEffect(() => {
    review
      .getReviewSettings()
      .then((res) => setNewPerDay(res.newPerDay))
      .catch(() => setNewPerDay(null));
  }, []);

  // 关键字：停手 300ms 再查
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((f) => (f.q === (search.trim() || undefined) ? f : { ...f, q: search.trim() || undefined }));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const todo = counts ? counts.due + counts.fresh : 0;
  const scopeLabel = noteTitle
    ? `「${noteTitle}」`
    : filters.group
      ? `分组「${filters.group === "none" ? "未分组" : filters.group}」`
      : filters.tag
        ? `#${filters.tag}`
        : "全部";

  if (reviewing) {
    return (
      <ReviewSession
        filters={filters}
        scopeLabel={scopeLabel}
        onOpenNote={onOpenNote}
        onOpenWikilink={onOpenWikilink}
        onChanged={onChanged}
        onExit={() => setReviewing(false)}
      />
    );
  }

  return (
    <div className="cards">
      <header className="cards__head">
        <div>
          <h1>知识简卡</h1>
          <p className="cards__sub">
            {counts
              ? `${scopeLabel}共 ${counts.total} 张 · 今天要复习 ${counts.due} 张、新学 ${counts.fresh} 张 · 明天到期 ${counts.tomorrow} 张`
              : "正在读取…"}
          </p>
        </div>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => setReviewing(true)}
          disabled={!counts || todo === 0}
          title="开始复习（Ctrl+Shift+R）"
        >
          <Icon name="zap" size={15} />
          {todo > 0 ? `今日复习 ${todo} 张` : "今天复习完了"}
        </button>
      </header>

      <div className="cards__filters" role="search">
        {noteTitle ? (
          <span className="cards__scope">
            只看「{noteTitle}」
            <button
              type="button"
              className="icon-btn"
              aria-label="看全部简卡"
              onClick={() => {
                setNoteTitle(null);
                setFilters((f) => ({ ...f, note: undefined }));
              }}
            >
              <Icon name="x" size={13} />
            </button>
          </span>
        ) : null}
        <select
          className="cards__select"
          aria-label="按分组筛选"
          value={filters.group ?? ""}
          onChange={(event) => setFilters((f) => ({ ...f, group: event.target.value || undefined }))}
        >
          <option value="">全部分组</option>
          {groups.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          <option value="none">未分组</option>
        </select>
        <select
          className="cards__select"
          aria-label="按标签筛选"
          value={filters.tag ?? ""}
          onChange={(event) => setFilters((f) => ({ ...f, tag: event.target.value || undefined }))}
        >
          <option value="">全部标签</option>
          {tags.map((t) => (
            <option key={t.tag} value={t.tag}>
              #{t.tag}
            </option>
          ))}
        </select>
        <input
          className="cards__search"
          type="search"
          placeholder="搜卡片标题、要点"
          aria-label="搜索简卡"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select className="cards__select" aria-label="排序" value={sort} onChange={(event) => setSort(event.target.value as CardSort)}>
          {(Object.keys(SORT_LABEL) as CardSort[]).map((key) => (
            <option key={key} value={key}>
              {SORT_LABEL[key]}
            </option>
          ))}
        </select>
        {newPerDay !== null ? (
          <label className="cards__limit" title="每天最多学多少张新卡">
            每天新卡
            <select
              className="cards__select"
              aria-label="每天新卡上限"
              value={newPerDay}
              onChange={async (event) => {
                const value = Number(event.target.value);
                try {
                  const res = await review.saveReviewSettings(value);
                  setNewPerDay(res.newPerDay);
                  void load();
                  onChanged();
                } catch (err) {
                  setError(api.errorMessage(err));
                }
              }}
            >
              {[...new Set([...NEW_PER_DAY_OPTIONS, newPerDay])]
                .sort((a, b) => a - b)
                .map((n) => (
                  <option key={n} value={n}>
                    {n} 张
                  </option>
                ))}
            </select>
          </label>
        ) : null}
      </div>

      {error ? (
        <p className="cards__state cards__state--error" role="alert">
          读取简卡失败：{error}
        </p>
      ) : items === null ? (
        <p className="cards__state">正在读取…</p>
      ) : items.length === 0 ? (
        <div className="cards__empty">
          <p>{counts && counts.total === 0 && !filters.group && !filters.tag && !filters.q && !filters.note ? "还没有简卡。" : "没有符合筛选的简卡。"}</p>
          <p className="cards__hint">
            在笔记里这样写就会出现在这里：
            <code>{"> [!card] 梯度下降"}</code>（下一行起用 <code>{">"}</code> 写要点），或者一行 <code>过拟合 :: 学进了噪声</code>。
          </p>
        </div>
      ) : (
        <ul className="cards__grid">
          {items.map((card) => (
            <li key={card.id}>
              <CardTile
                card={card}
                open={expanded === card.id}
                onToggle={() => setExpanded((id) => (id === card.id ? null : card.id))}
                onOpenNote={onOpenNote}
                onOpenWikilink={onOpenWikilink}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CardTile({
  card,
  open,
  onToggle,
  onOpenNote,
  onOpenWikilink,
}: {
  card: KCard;
  open: boolean;
  onToggle: () => void;
  onOpenNote: (id: string) => void;
  onOpenWikilink: (title: string) => void;
}) {
  const now = Date.now();
  return (
    <article className={`kcard-tile${open ? " is-open" : ""}`}>
      <button type="button" className="kcard-tile__main" onClick={onToggle} aria-expanded={open}>
        <span className="kcard-tile__title">{card.title}</span>
        <span className={`kcard-tile__mastery kcard-tile__mastery--${card.mastery}`}>{MASTERY_LABEL[card.mastery]}</span>
      </button>
      <div className="kcard-tile__body">
        <Preview markdown={card.body} notePath={card.notePath} onOpenWikilink={onOpenWikilink} onFilterTag={() => undefined} />
      </div>
      <footer className="kcard-tile__foot">
        <button type="button" className="link-btn kcard-tile__note" onClick={() => onOpenNote(card.noteId)} title="打开原笔记">
          <Icon name="notes" size={12} />
          {card.noteTitle}
        </button>
        <span className="kcard-tile__due">{dueLabel(card.due, now)}</span>
      </footer>
    </article>
  );
}

type SessionStats = { done: number; remembered: number };

function ReviewSession({
  filters,
  scopeLabel,
  onOpenNote,
  onOpenWikilink,
  onChanged,
  onExit,
}: {
  filters: CardFilters;
  scopeLabel: string;
  onOpenNote: (id: string) => void;
  onOpenWikilink: (title: string) => void;
  onChanged: () => void;
  onExit: () => void;
}) {
  const [queue, setQueue] = useState<QueueCard[] | null>(null);
  const [flipped, setFlipped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<SessionStats>({ done: 0, remembered: 0 });
  const [tomorrow, setTomorrow] = useState<number | null>(null);
  /** 可以撤回的打分（最近的在最后） */
  const history = useRef<Array<{ id: string; grade: Grade }>>([]);
  const cardRef = useRef<HTMLDivElement>(null);

  const fetchQueue = useCallback(
    async (front?: string) => {
      const res = await review.reviewQueue(filters);
      let items = res.items;
      if (front) {
        const hit = items.find((c) => c.id === front);
        if (hit) items = [hit, ...items.filter((c) => c.id !== front)];
      }
      setQueue(items);
      setFlipped(false);
      if (items.length === 0) {
        review
          .listCards(filters, "recent")
          .then((r) => setTomorrow(r.tomorrow))
          .catch(() => setTomorrow(null));
      }
    },
    [filters],
  );

  useEffect(() => {
    fetchQueue().catch((err) => setError(api.errorMessage(err)));
  }, [fetchQueue]);

  const current = queue && queue.length > 0 ? queue[0] : null;

  useEffect(() => {
    cardRef.current?.focus();
  }, [current?.id, flipped]);

  const grade = useCallback(
    async (g: Grade) => {
      if (!current || !flipped || busy) return;
      setBusy(true);
      setError(null);
      try {
        await review.gradeCard(current.id, g);
        history.current.push({ id: current.id, grade: g });
        setStats((s) => ({ done: s.done + 1, remembered: s.remembered + (g >= 2 ? 1 : 0) }));
        onChanged();
        await fetchQueue();
      } catch (err) {
        setError(api.errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [current, flipped, busy, fetchQueue, onChanged],
  );

  const undo = useCallback(async () => {
    const last = history.current.at(-1);
    if (!last || busy) return;
    setBusy(true);
    setError(null);
    try {
      await review.undoGrade(last.id);
      history.current.pop();
      setStats((s) => ({ done: Math.max(0, s.done - 1), remembered: Math.max(0, s.remembered - (last.grade >= 2 ? 1 : 0)) }));
      onChanged();
      await fetchQueue(last.id);
    } catch (err) {
      setError(api.errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [busy, fetchQueue, onChanged]);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void undo();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onExit();
      } else if ((event.key === " " || event.key === "Enter") && current && !flipped) {
        event.preventDefault();
        setFlipped(true);
      } else if (["1", "2", "3", "4"].includes(event.key) && flipped) {
        event.preventDefault();
        void grade(Number(event.key) as Grade);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, flipped, grade, undo, onExit]);

  const now = Date.now();
  const total = queue ? stats.done + queue.length : 0;

  return (
    <div className="review">
      <header className="review__head">
        <button type="button" className="btn btn--small" onClick={onExit}>
          <Icon name="x" size={13} />
          结束复习
        </button>
        <span className="review__scope">{scopeLabel}</span>
        <span className="review__progress" aria-live="polite">
          {queue ? `${stats.done} / ${total}` : ""}
        </span>
        <button
          type="button"
          className="btn btn--small"
          onClick={() => void undo()}
          disabled={history.current.length === 0 || busy}
          title="撤回上一次打分（Ctrl+Z）"
        >
          <Icon name="undo" size={13} />
          撤回
        </button>
      </header>

      {error ? (
        <p className="cards__state cards__state--error" role="alert">
          {error}
        </p>
      ) : null}

      {queue === null ? (
        <p className="cards__state">正在读取今天要复习的卡片…</p>
      ) : !current ? (
        <div className="review__done">
          <h2>{stats.done > 0 ? "今天的复习完成了" : "现在没有要复习的卡片"}</h2>
          {stats.done > 0 ? (
            <p>
              本次复习 {stats.done} 张，记住 {stats.remembered} 张（{Math.round((stats.remembered / stats.done) * 100)}%）。
            </p>
          ) : null}
          {tomorrow !== null ? <p>明天预计到期 {tomorrow} 张。</p> : null}
          <button type="button" className="btn btn--primary" onClick={onExit}>
            回到卡片墙
          </button>
        </div>
      ) : (
        <div className="review__stage">
          <div
            ref={cardRef}
            className={`review-card${flipped ? " is-flipped" : ""}`}
            tabIndex={-1}
            role="group"
            aria-label={flipped ? `简卡背面：${current.title}` : `简卡正面：${current.title}`}
          >
            <div className="review-card__meta">
              <span className={`kcard-tile__mastery kcard-tile__mastery--${current.mastery}`}>{MASTERY_LABEL[current.mastery]}</span>
              <button type="button" className="link-btn" onClick={() => onOpenNote(current.noteId)} title="打开原笔记">
                {current.noteTitle}
              </button>
            </div>
            <h2 className="review-card__title">{current.title}</h2>
            {flipped ? (
              <div className="review-card__body">
                <Preview markdown={current.body} notePath={current.notePath} onOpenWikilink={onOpenWikilink} onFilterTag={() => undefined} />
              </div>
            ) : (
              <p className="review-card__hint">先在心里回想要点，再翻面对照。</p>
            )}
          </div>

          {!flipped ? (
            <button type="button" className="btn btn--primary review__flip" onClick={() => setFlipped(true)}>
              翻面看要点<kbd>空格</kbd>
            </button>
          ) : (
            <div className="review__grades" role="group" aria-label="记得怎么样">
              {([1, 2, 3, 4] as Grade[]).map((g) => (
                <button
                  key={g}
                  type="button"
                  className={`review__grade review__grade--${g}`}
                  onClick={() => void grade(g)}
                  disabled={busy}
                >
                  <span className="review__grade-label">{GRADE_LABEL[g]}</span>
                  <span className="review__grade-next">{formatSpan(current.next[g] - now)}</span>
                  <kbd>{g}</kbd>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 卡片墙之外用到的到期数（左栏、首页） */
export function useReviewSummary(refreshKey: unknown): review.ReviewCounts | null {
  const [summary, setSummary] = useState<review.ReviewCounts | null>(null);
  useEffect(() => {
    let alive = true;
    review
      .reviewSummary()
      .then((res) => {
        if (alive) setSummary(res);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [refreshKey]);
  return useMemo(() => summary, [summary]);
}
