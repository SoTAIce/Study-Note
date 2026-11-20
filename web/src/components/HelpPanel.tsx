import { useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../api.ts";
import * as helpApi from "../help-api.ts";
import type { ManualState } from "../help-api.ts";
import { isTopDialog } from "../lib/focus-trap.ts";
import { CHEAT_GROUPS, CHEAT_SHEET, chapterForLink, filterCheatSheet, groupChapters } from "../lib/help.ts";
import { useDialogFocus } from "../lib/use-dialog-focus.ts";
import { useConfirm } from "./ConfirmDialog.tsx";
import Icon from "./Icon.tsx";
import Preview from "./Preview.tsx";

export type HelpTab = "cheat" | "manual";

/**
 * 帮助面板（help-001）：右侧抽屉，两个页签。
 * - 速查：快捷键和语法，按场景分组，顶上筛选；
 * - 使用手册：只读的章节（manual/*.md），章内 [[手册：…]] 在面板里跳；底下生成 / 重新生成 / 删除练习笔记。
 */
type Props = {
  initialTab: HelpTab;
  onClose: () => void;
  onNotify: (text: string, kind?: "ok" | "info" | "error") => void;
  /** 生成练习笔记后：App 刷新左栏、打开连读；重新生成时 trashedIds 是移进回收站的旧练习笔记 */
  onInstalled: (group: string, trashedIds: string[]) => void;
  /** 删除练习笔记后：App 关掉开着的那几篇、刷新左栏和列表 */
  onRemoved: (trashedIds: string[]) => void;
  /** 动练习笔记之前：先把编辑器里没保存的存掉，返回是否成功 */
  beforeChange: () => Promise<boolean>;
};

export default function HelpPanel({ initialTab, onClose, onNotify, onInstalled, onRemoved, beforeChange }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef);
  const confirm = useConfirm();
  const [tab, setTab] = useState<HelpTab>(initialTab);
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState<ManualState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chapterSlug, setChapterSlug] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    helpApi.getManual().then(
      (state) => {
        setManual(state);
        setChapterSlug((slug) => slug ?? state.chapters[0]?.slug ?? null);
      },
      (err: unknown) => setLoadError(errorMessage(err)),
    );
  }, []);

  useEffect(() => {
    if (tab !== "cheat") return;
    const timer = window.setTimeout(() => filterRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [tab]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || !isTopDialog(dialog) || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows = useMemo(() => filterCheatSheet(CHEAT_SHEET, query), [query]);
  const chapter = manual?.chapters.find((item) => item.slug === chapterSlug) ?? null;
  const parts = useMemo(() => groupChapters(manual?.chapters ?? []), [manual]);

  function openChapter(slug: string): void {
    setChapterSlug(slug);
    contentRef.current?.scrollTo({ top: 0 });
  }

  async function install(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const result = await helpApi.installManual();
      setManual(result);
      onNotify(`已生成 ${result.installed.count} 篇练习笔记，可以随便改，练完在帮助里一键删除`, "ok");
      onInstalled(result.group, []);
    } catch (err) {
      onNotify(`生成失败：${errorMessage(err)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function reinstall(): Promise<void> {
    if (busy) return;
    const ok = await confirm({
      title: "换成最新版的练习笔记？",
      message: "现在的练习笔记（包括你改过的）会先移进回收站，再生成最新版。回收站里能找回。",
      confirmLabel: "重新生成",
    });
    if (!ok) return;
    if (!(await beforeChange())) {
      onNotify("当前笔记还没保存成功，先处理冲突再重新生成", "error");
      return;
    }
    setBusy(true);
    try {
      const result = await helpApi.reinstallManual();
      setManual(result);
      onNotify(`已换成最新版（旧的 ${result.trashed} 篇在回收站）`, "ok");
      onInstalled(result.group, result.trashedIds);
    } catch (err) {
      onNotify(`重新生成失败：${errorMessage(err)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (busy) return;
    const ok = await confirm({
      title: "删除练习笔记？",
      message: "带手册标记的练习笔记会移进回收站；同一个组里你自己写的笔记不动。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    if (!(await beforeChange())) {
      onNotify("当前笔记还没保存成功，先处理冲突再删除", "error");
      return;
    }
    setBusy(true);
    try {
      const result = await helpApi.deleteManual();
      setManual(result);
      onNotify(`已把 ${result.trashed} 篇练习笔记移进回收站`, "ok");
      onRemoved(result.trashedIds);
    } catch (err) {
      onNotify(`删除失败：${errorMessage(err)}`, "error");
    } finally {
      setBusy(false);
    }
  }

  const installed = manual?.installed.count ?? 0;
  const outdated = installed > 0 && manual?.installed.version !== manual?.version;

  return (
    <div className="overlay overlay--right" role="presentation" onMouseDown={onClose}>
      <div
        className="help-panel"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="帮助"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="history__head">
          <span className="history__icon" aria-hidden="true">
            <Icon name="help" size={17} />
          </span>
          <div className="history__heading">
            <h2>帮助</h2>
            <span className="history__sub">快捷键、写法和使用手册</span>
          </div>
          <div className="segmented" role="tablist" aria-label="帮助内容">
            {(
              [
                ["cheat", "速查"],
                ["manual", "使用手册"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                className={`segmented__btn segmented__btn--text${tab === value ? " is-active" : ""}`}
                onClick={() => setTab(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭帮助" title="关闭（Esc）">
            <Icon name="x" size={17} />
          </button>
        </header>

        {tab === "cheat" ? (
          <div className="help-panel__cheat">
            <div className="help-panel__filter">
              <Icon name="search" size={14} />
              <input
                ref={filterRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="筛选：输入「复习」「图片」「Ctrl+K」…"
                aria-label="筛选快捷键和写法"
                spellCheck={false}
              />
            </div>
            <div className="help-panel__scroll">
              {rows.length === 0 ? <p className="history__state">没有和「{query.trim()}」相关的。</p> : null}
              {CHEAT_GROUPS.map((group) => {
                const items = rows.filter((row) => row.group === group);
                if (items.length === 0) return null;
                return (
                  <section key={group} className="help-panel__group" aria-label={group}>
                    <h3>{group}</h3>
                    <dl>
                      {items.map((row) => (
                        <div key={`${row.group}-${row.keys}`} className="help-panel__row">
                          <dt>
                            <kbd>{row.keys}</kbd>
                          </dt>
                          <dd>
                            {row.does}
                            {row.note ? <span className="help-panel__note">{row.note}</span> : null}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="help-panel__manual">
            {loadError ? (
              <p className="history__state history__state--error" role="alert">
                读不到使用手册：{loadError}
              </p>
            ) : !manual ? (
              <p className="history__state">正在读取使用手册…</p>
            ) : (
              <>
                <nav className="help-panel__toc" aria-label="手册目录">
                  {parts.map((part) => (
                    <div key={part.part} className="help-panel__part">
                      <span className="help-panel__part-title">{part.part}</span>
                      {part.chapters.map((item) => (
                        <button
                          key={item.slug}
                          type="button"
                          className={`help-panel__chapter${item.slug === chapterSlug ? " is-active" : ""}`}
                          aria-current={item.slug === chapterSlug ? "page" : undefined}
                          onClick={() => openChapter(item.slug)}
                        >
                          {item.title.replace(/^手册：/, "")}
                        </button>
                      ))}
                    </div>
                  ))}
                </nav>
                <div className="help-panel__content" ref={contentRef}>
                  {chapter ? (
                    <article className="help-panel__article" aria-label={chapter.title}>
                      <h1>{chapter.title.replace(/^手册：/, "")}</h1>
                      <Preview
                        markdown={chapter.body}
                        knownTitles={new Set(manual.chapters.map((item) => item.title))}
                        onOpenWikilink={(target) => {
                          const found = chapterForLink(manual.chapters, target);
                          if (found) openChapter(found.slug);
                        }}
                        onFilterTag={() => undefined}
                      />
                      {installed === 0 ? (
                        <p className="help-panel__hint">「动手试试」要在练习笔记里做：点下面的「生成练习笔记」。</p>
                      ) : null}
                    </article>
                  ) : null}
                </div>
              </>
            )}
          </div>
        )}

        {tab === "manual" && manual ? (
          <footer className="history__foot">
            <span className="history__foothint">
              {installed > 0
                ? `练习笔记在「使用手册/练习」里，共 ${installed} 篇${outdated ? "（手册已更新，可以重新生成）" : ""}`
                : "生成一份练习用的副本：每章一篇真笔记，可以连读、随便改"}
            </span>
            <div className="history__actions">
              {installed > 0 ? (
                <>
                  <button type="button" className="btn btn--small btn--danger" onClick={() => void remove()} disabled={busy}>
                    删除练习笔记
                  </button>
                  <button type="button" className={`btn btn--small${outdated ? " btn--primary" : ""}`} onClick={() => void reinstall()} disabled={busy}>
                    重新生成（换成最新版）
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn--small btn--primary" onClick={() => void install()} disabled={busy}>
                  {busy ? "生成中…" : "生成练习笔记"}
                </button>
              )}
            </div>
          </footer>
        ) : null}
      </div>
    </div>
  );
}
