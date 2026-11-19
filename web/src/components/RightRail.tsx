import { useEffect, useState } from "react";
import * as api from "../api.ts";
import { listCards, type ReviewCounts } from "../review-api.ts";
import type { BacklinksResult } from "../api.ts";
import AiPanel from "./AiPanel.tsx";
import Icon from "./Icon.tsx";

type Props = {
  backlinks: BacklinksResult | null;
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onOpenNote: (id: string) => void;
  onOpenTitle: (title: string) => void;
  onClose: () => void;
  /** 知识简卡（srs-001）：这篇笔记的卡片数；version 变了（保存过）就重新查 */
  cards: { noteId: string | null; version: string; onReview: () => void; onOpenWall: () => void };
  ai: {
    noteId: string | null;
    noteTitle: string;
    noteBody: string;
    selectionLength: number;
    getSelection: () => string;
    onInsert: (text: string, where: "cursor" | "end" | "replace") => void;
    onReplaceAll: (text: string) => void;
    /** 打开「按模板规整」预览（tpl-002） */
    onArrange?: () => void;
    focusSignal: number;
    beforeRun?: () => Promise<void>;
  };
};

export default function RightRail({
  backlinks,
  loading,
  error,
  onReload,
  onOpenNote,
  onOpenTitle,
  onClose,
  cards,
  ai,
}: Props) {
  const [cardCounts, setCardCounts] = useState<ReviewCounts | null>(null);
  useEffect(() => {
    setCardCounts(null);
    if (!cards.noteId) return;
    let alive = true;
    listCards({ note: cards.noteId }, "recent")
      .then((res) => {
        if (alive) setCardCounts({ total: res.total, due: res.due, fresh: res.fresh, tomorrow: res.tomorrow });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [cards.noteId, cards.version]);
  const todo = cardCounts ? cardCounts.due + cardCounts.fresh : 0;

  return (
    <aside className="rail" aria-label="关联与 AI">
      <header className="rail__head">
        <h2>
          <Icon name="link" size={15} />
          关联与 AI
        </h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="收起关联面板" title="收起">
          <Icon name="x" size={16} />
        </button>
      </header>

      <div className="rail__scroll">
        {cardCounts && cardCounts.total > 0 ? (
          <section className="rail__section rail__cards" aria-label="这篇的知识简卡">
            <div className="rail__sectionhead">
              <h3>知识简卡</h3>
              <span className="rail__count">{cardCounts.total}</span>
            </div>
            <p className="rail__state">
              这篇有 {cardCounts.total} 张简卡{todo > 0 ? `，今天要复习 ${todo} 张` : "，今天都复习过了"}。
            </p>
            <div className="rail__cards-actions">
              <button type="button" className="btn btn--small btn--primary" onClick={cards.onReview} disabled={todo === 0}>
                复习这篇
              </button>
              <button type="button" className="btn btn--small" onClick={cards.onOpenWall}>
                在卡片墙看
              </button>
            </div>
          </section>
        ) : null}
        <section className="rail__section" aria-label="反查链接">
          <div className="rail__sectionhead">
            <h3>反查链接</h3>
            <span className="rail__count">{backlinks ? backlinks.backlinks.length : "–"}</span>
          </div>
          {loading ? <p className="rail__state">正在查引用…</p> : null}
          {error ? (
            <div className="rail__state rail__state--error" role="alert">
              <span>读取失败：{error}</span>
              <button type="button" className="link-btn" onClick={onReload}>
                重试
              </button>
            </div>
          ) : null}
          {!loading && !error && backlinks && backlinks.backlinks.length === 0 ? (
            <p className="rail__state rail__state--dim">还没有别的笔记引用这条。在其它笔记里写 [[{ai.noteTitle || "标题"}]] 就会出现在这里。</p>
          ) : null}
          <ul className="rail__list">
            {backlinks?.backlinks.map((item) => (
              <li key={item.id}>
                <button type="button" className="rail__link" onClick={() => onOpenNote(item.id)}>
                  <span className="rail__link-title">{item.title}</span>
                  <span className="rail__link-path">{item.relPath}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="rail__section" aria-label="出链">
          <div className="rail__sectionhead">
            <h3>出链</h3>
            <span className="rail__count">{backlinks ? backlinks.outlinks.length : "–"}</span>
          </div>
          {!loading && !error && backlinks && backlinks.outlinks.length === 0 ? (
            <p className="rail__state rail__state--dim">这条笔记还没有 [[双链]]。</p>
          ) : null}
          <ul className="rail__list">
            {backlinks?.outlinks.map((link, index) => (
              <li key={`${link.title}-${index}`}>
                {link.resolved && link.targetId ? (
                  <button type="button" className="rail__link" onClick={() => onOpenNote(link.targetId as string)}>
                    <span className="rail__link-title">{link.title}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="rail__link rail__link--missing"
                    onClick={() => onOpenTitle(link.title)}
                    title="这条笔记还不存在，点击新建"
                  >
                    <span className="rail__link-title">{link.title}</span>
                    <span className="rail__link-badge">未创建</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        <AiPanel
          noteId={ai.noteId}
          noteTitle={ai.noteTitle}
          noteBody={ai.noteBody}
          selectionLength={ai.selectionLength}
          getSelection={ai.getSelection}
          onInsert={ai.onInsert}
          onReplaceAll={ai.onReplaceAll}
          onArrange={ai.onArrange}
          focusSignal={ai.focusSignal}
          beforeRun={ai.beforeRun}
        />
      </div>

      <footer className="rail__foot">
        <span className="muted">Ctrl+J 唤起 AI</span>
      </footer>
    </aside>
  );
}
