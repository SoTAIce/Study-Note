import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api.ts";
import type { HistoryEntry, HistoryReason, HistoryVersion } from "../api.ts";
import { diffLines, diffStats, foldUnchanged } from "../lib/diff.ts";
import { clockTime, dayKey, dayLabel, relativeTime } from "../lib/time.ts";
import Icon from "./Icon.tsx";
import Preview from "./Preview.tsx";

type Props = {
  open: boolean;
  noteId: string;
  noteTitle: string;
  /** 编辑器里的当前正文（含未保存修改），用于「与当前对比」 */
  currentBody: string;
  onClose: () => void;
  /** 恢复到某个版本；返回是否成功（失败时面板保持打开） */
  onRestore: (versionId: string, label: string) => Promise<boolean>;
};

const REASON_LABEL: Record<HistoryReason, string> = {
  edit: "自动存档",
  ai: "AI 改写前",
  restore: "恢复前",
  "backup-restore": "备份恢复前",
  agent: "AI 计划前",
};

type View = "preview" | "diff";

function versionLabel(entry: HistoryEntry): string {
  return `${dayLabel(entry.at)} ${clockTime(entry.at)}`;
}

export default function HistoryPanel({ open, noteId, noteTitle, currentBody, onClose, onRestore }: Props) {
  const [items, setItems] = useState<HistoryEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [versions, setVersions] = useState<Record<string, HistoryVersion>>({});
  const [versionError, setVersionError] = useState<string | null>(null);
  const [view, setView] = useState<View>("diff");
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  async function loadList(): Promise<void> {
    setListError(null);
    try {
      const res = await api.listHistory(noteId);
      setItems(res.items);
      setSelectedId((prev) => (prev && res.items.some((item) => item.versionId === prev) ? prev : res.items[0]?.versionId ?? null));
    } catch (err) {
      setItems([]);
      setListError(api.errorMessage(err));
    }
  }

  // 打开或换了一篇：清空缓存重新拉
  useEffect(() => {
    if (!open) return;
    setItems(null);
    setVersions({});
    setSelectedId(null);
    setConfirming(false);
    setVersionError(null);
    void loadList();
    // loadList 每次渲染都是新引用；只跟 open / noteId 走
  }, [open, noteId]);

  // 选中某个版本就拉正文（有缓存就不拉）
  useEffect(() => {
    if (!open || !selectedId || versions[selectedId]) return;
    let cancelled = false;
    setVersionError(null);
    api
      .getHistoryVersion(noteId, selectedId)
      .then((version) => {
        if (!cancelled) setVersions((prev) => ({ ...prev, [version.versionId]: version }));
      })
      .catch((err) => {
        if (!cancelled) setVersionError(api.errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, noteId, selectedId, versions]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        if (confirming) setConfirming(false);
        else onClose();
        return;
      }
      if ((event.key === "ArrowDown" || event.key === "ArrowUp") && items && items.length > 0) {
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
        event.preventDefault();
        const index = items.findIndex((item) => item.versionId === selectedId);
        const next = event.key === "ArrowDown" ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1);
        setSelectedId(items[next].versionId);
        setConfirming(false);
        listRef.current
          ?.querySelector<HTMLElement>(`[data-version="${items[next].versionId}"]`)
          ?.scrollIntoView({ block: "nearest" });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, confirming, items, selectedId, onClose]);

  const groups = useMemo(() => {
    const out: Array<{ key: string; label: string; items: HistoryEntry[] }> = [];
    for (const item of items ?? []) {
      const key = dayKey(item.at);
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(item);
      else out.push({ key, label: dayLabel(item.at), items: [item] });
    }
    return out;
  }, [items]);

  const selected = selectedId ? versions[selectedId] ?? null : null;
  const selectedEntry = items?.find((item) => item.versionId === selectedId) ?? null;

  const diff = useMemo(() => {
    if (!selected || view !== "diff") return null;
    const lines = diffLines(selected.body, currentBody);
    return { rows: foldUnchanged(lines, 3), stats: diffStats(lines) };
  }, [selected, currentBody, view]);

  if (!open) return null;

  async function confirmRestore(): Promise<void> {
    if (!selectedEntry || restoring) return;
    setRestoring(true);
    const ok = await onRestore(selectedEntry.versionId, versionLabel(selectedEntry));
    setRestoring(false);
    setConfirming(false);
    if (ok) onClose();
  }

  function renderList() {
    if (items === null) {
      return (
        <div className="skeleton-list" aria-label="正在读取历史版本">
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="skeleton skeleton--short" />
        </div>
      );
    }
    if (listError) {
      return (
        <div className="history__state history__state--error" role="alert">
          <p>读取历史版本失败：{listError}</p>
          <button type="button" className="btn btn--small" onClick={() => void loadList()}>
            重试
          </button>
        </div>
      );
    }
    if (items.length === 0) {
      return (
        <div className="history__state">
          <Icon name="history" size={22} />
          <p>还没有历史版本。</p>
          <p className="history__hint">
            每次打开笔记后的第一次保存、之后每隔 10 分钟、以及 AI 改写之前，都会自动存一份。
          </p>
        </div>
      );
    }
    return groups.map((group) => (
      <section key={group.key} className="history__day">
        <h3 className="history__dayhead">{group.label}</h3>
        {group.items.map((item) => {
          const delta = item.chars - currentBody.length;
          return (
            <button
              key={item.versionId}
              type="button"
              data-version={item.versionId}
              className={`history__item${item.versionId === selectedId ? " is-active" : ""}`}
              onClick={() => {
                setSelectedId(item.versionId);
                setConfirming(false);
              }}
              aria-current={item.versionId === selectedId ? "true" : undefined}
            >
              <span className="history__itemtop">
                <span className="history__time">{clockTime(item.at)}</span>
                <span className={`history__reason history__reason--${item.reason}`}>{REASON_LABEL[item.reason]}</span>
              </span>
              <span className="history__itemmeta">
                <span className="history__title">{item.title || "未命名"}</span>
                <span className={`history__delta${delta > 0 ? " is-more" : delta < 0 ? " is-less" : ""}`}>
                  {item.chars} 字{delta !== 0 ? ` · 比现在${delta > 0 ? "多" : "少"} ${Math.abs(delta)}` : " · 同现在"}
                </span>
              </span>
            </button>
          );
        })}
      </section>
    ));
  }

  function renderContent() {
    if (!selectedEntry) {
      return <div className="history__state">在左边选一个版本查看。</div>;
    }
    if (versionError) {
      return (
        <div className="history__state history__state--error" role="alert">
          <p>读取这个版本失败：{versionError}</p>
        </div>
      );
    }
    if (!selected) {
      return (
        <div className="history__state">
          <p>正在读取…</p>
        </div>
      );
    }
    if (view === "preview") {
      return (
        <div className="history__preview">
          {selected.meta.title && selected.meta.title !== noteTitle ? (
            <p className="history__note">
              这个版本的标题是「{selected.meta.title}」，恢复时标题也会一起改回去。
            </p>
          ) : null}
          <Preview markdown={selected.body} onOpenWikilink={() => undefined} onFilterTag={() => undefined} />
        </div>
      );
    }
    if (!diff) return null;
    if (diff.stats.added === 0 && diff.stats.removed === 0) {
      return (
        <div className="history__state">
          <Icon name="check" size={20} />
          <p>正文和现在完全一样。</p>
        </div>
      );
    }
    return (
      <div className="diff" role="table" aria-label="与当前内容的逐行对比">
        {diff.rows.map((row, index) =>
          row.kind === "fold" ? (
            <div key={index} className="diff__fold" role="row">
              ··· {row.count} 行没有变化 ···
            </div>
          ) : (
            <div key={index} className={`diff__line diff__line--${row.kind}`} role="row">
              <span className="diff__sign" aria-hidden="true">
                {row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}
              </span>
              <span className="diff__text">{row.text || " "}</span>
            </div>
          ),
        )}
      </div>
    );
  }

  return (
    <div className="overlay overlay--right" role="presentation" onMouseDown={onClose}>
      <div
        className="history"
        role="dialog"
        aria-modal="true"
        aria-label="历史版本"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="history__head">
          <span className="history__icon" aria-hidden="true">
            <Icon name="history" size={17} />
          </span>
          <div className="history__heading">
            <h2>历史版本</h2>
            <span className="history__sub">{noteTitle || "未命名"}</span>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭历史版本" title="关闭（Esc）">
            <Icon name="x" size={17} />
          </button>
        </header>

        <div className="history__body">
          <div className="history__list" ref={listRef}>
            {renderList()}
          </div>

          <div className="history__content">
            {selectedEntry ? (
              <div className="history__toolbar">
                <div className="history__meta">
                  <strong>{versionLabel(selectedEntry)}</strong>
                  <span>
                    {REASON_LABEL[selectedEntry.reason]} · 存档于 {relativeTime(selectedEntry.takenAt)}
                  </span>
                </div>
                <div className="segmented" role="tablist" aria-label="查看方式">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={view === "diff"}
                    className={`segmented__btn segmented__btn--text${view === "diff" ? " is-active" : ""}`}
                    onClick={() => setView("diff")}
                  >
                    与当前对比
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={view === "preview"}
                    className={`segmented__btn segmented__btn--text${view === "preview" ? " is-active" : ""}`}
                    onClick={() => setView("preview")}
                  >
                    预览
                  </button>
                </div>
              </div>
            ) : null}

            {diff && view === "diff" && (diff.stats.added > 0 || diff.stats.removed > 0) ? (
              <p className="history__legend">
                从这个版本到现在：
                {diff.stats.added > 0 ? <span className="history__plus">+{diff.stats.added} 行</span> : null}
                {diff.stats.removed > 0 ? <span className="history__minus">−{diff.stats.removed} 行</span> : null}
                <span className="history__legendhint">（红色是这个版本里有、现在没有的）</span>
              </p>
            ) : null}

            <div className="history__scroll">{renderContent()}</div>

            {selectedEntry ? (
              <footer className="history__foot">
                {confirming ? (
                  <>
                    <span className="history__confirmtext">
                      把正文、标题和标签恢复到 {versionLabel(selectedEntry)}？现在的内容会先存成一份历史版本，可以再恢复回来。
                    </span>
                    <div className="history__actions">
                      <button type="button" className="btn btn--small" onClick={() => setConfirming(false)} disabled={restoring}>
                        取消
                      </button>
                      <button
                        type="button"
                        className="btn btn--small btn--primary"
                        onClick={() => void confirmRestore()}
                        disabled={restoring}
                      >
                        {restoring ? "恢复中…" : "确认恢复"}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="history__foothint">↑ ↓ 切换版本 · Esc 关闭</span>
                    <button
                      type="button"
                      className="btn btn--small btn--primary"
                      onClick={() => setConfirming(true)}
                      disabled={!selected}
                    >
                      <Icon name="undo" size={13} />
                      恢复到此版本
                    </button>
                  </>
                )}
              </footer>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
