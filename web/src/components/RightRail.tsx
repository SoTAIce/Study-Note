import * as api from "../api.ts";
import type { BacklinksResult } from "../api.ts";
import AiPanel from "./AiPanel.tsx";

type Props = {
  backlinks: BacklinksResult | null;
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onOpenNote: (id: string) => void;
  onOpenTitle: (title: string) => void;
  onClose: () => void;
  ai: {
    noteId: string | null;
    noteTitle: string;
    noteBody: string;
    selectionLength: number;
    getSelection: () => string;
    onInsert: (text: string, where: "cursor" | "end" | "replace") => void;
    onReplaceAll: (text: string) => void;
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
  ai,
}: Props) {
  return (
    <aside className="rail" aria-label="关联与 AI">
      <header className="rail__head">
        <h2>关联</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="收起关联面板" title="收起">
          ×
        </button>
      </header>

      <div className="rail__scroll">
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
