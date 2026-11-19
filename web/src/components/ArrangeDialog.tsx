import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArrangeResult } from "../api.ts";
import * as api from "../api.ts";
import { diffLines, diffStats, foldUnchanged } from "../lib/diff.ts";
import { isTopDialog } from "../lib/focus-trap.ts";
import { OTHER_SECTION, type NoteTemplate } from "../lib/templates.ts";
import { useDialogFocus } from "../lib/use-dialog-focus.ts";
import DiffView from "./DiffView.tsx";
import Icon from "./Icon.tsx";

/**
 * 按模板规整的预览（tpl-002）：选模板 → AI 只回分配方案 → 看每个小节收了哪几块 + 前后逐行差异 → 应用。
 * 应用由 App 走「AI 整篇替换」：存历史版本、可撤销；这里不写任何东西。
 */
type Props = {
  noteTitle: string;
  templates: NoteTemplate[];
  /** 文件头 / 子项目默认里找到的模板；没有就先让人选 */
  initialTemplate: string | null;
  /** 打开时的正文（规整基于它，差异也拿它比） */
  currentBody: string;
  run: (template: string, signal: AbortSignal) => Promise<ArrangeResult>;
  onApply: (result: ArrangeResult) => void;
  onClose: () => void;
};

type Phase =
  | { kind: "choose" }
  | { kind: "running"; template: string }
  | { kind: "error"; template: string; message: string }
  | { kind: "done"; result: ArrangeResult };

function firstLine(text: string): string {
  const line = text.split("\n").find((item) => item.trim()) ?? "";
  const chars = [...line.trim()];
  return chars.length > 48 ? `${chars.slice(0, 48).join("")}…` : chars.join("");
}

function isAbort(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError";
}

export default function ArrangeDialog({ noteTitle, templates, initialTemplate, currentBody, run, onApply, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  useDialogFocus(dialogRef);

  const known = initialTemplate && templates.some((item) => item.name === initialTemplate) ? initialTemplate : null;
  const [choice, setChoice] = useState<string>(known ?? templates[0]?.name ?? "");
  const [phase, setPhase] = useState<Phase>(known ? { kind: "running", template: known } : { kind: "choose" });

  const start = useCallback(
    async (template: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setPhase({ kind: "running", template });
      try {
        const result = await run(template, controller.signal);
        if (controller.signal.aborted) return;
        setPhase({ kind: "done", result });
      } catch (err) {
        if (isAbort(err) || controller.signal.aborted) return;
        setPhase({ kind: "error", template, message: api.errorMessage(err) });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [run],
  );

  // 有模板就直接开始；卸载时掐掉还在等的请求
  useEffect(() => {
    if (known) void start(known);
    return () => abortRef.current?.abort();
    // 只在打开时跑一次
  }, []);

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

  const result = phase.kind === "done" ? phase.result : null;
  const diff = useMemo(() => {
    if (!result) return null;
    const lines = diffLines(currentBody, result.body);
    return { rows: foldUnchanged(lines, 3), stats: diffStats(lines) };
  }, [result, currentBody]);

  function cancel(): void {
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase({ kind: "choose" });
  }

  const busy = phase.kind === "running";
  const activeTemplate = phase.kind === "choose" ? choice : phase.kind === "done" ? phase.result.template : phase.template;

  function renderSummary(found: ArrangeResult) {
    const blockText = (index: number) => firstLine(found.blocks[index]?.text ?? "");
    const rows = [
      ...found.plan.sections.map((section) => ({ title: section.title, blocks: section.blocks })),
      ...(found.plan.other.length > 0 ? [{ title: OTHER_SECTION, blocks: found.plan.other }] : []),
    ];
    return (
      <ol className="arrange__sections" aria-label="每个小节收了哪几块">
        {rows.map((row) => (
          <li key={row.title} className={`arrange__section${row.title === OTHER_SECTION ? " is-other" : ""}`}>
            <div className="arrange__sectionhead">
              <strong>{row.title}</strong>
              <span>{row.blocks.length > 0 ? `${row.blocks.length} 块` : "待补"}</span>
            </div>
            {row.blocks.length > 0 ? (
              <ul className="arrange__blocks">
                {row.blocks.map((index) => (
                  <li key={index}>
                    <span className="arrange__num">{index}</span>
                    <span className="arrange__text">{blockText(index)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
        {found.plan.drop.length > 0 ? (
          <li className="arrange__section is-drop">
            <div className="arrange__sectionhead">
              <strong>换成模板标题</strong>
              <span>{found.plan.drop.length} 个</span>
            </div>
            <ul className="arrange__blocks">
              {found.plan.drop.map((index) => (
                <li key={index}>
                  <span className="arrange__num">{index}</span>
                  <span className="arrange__text">{blockText(index)}</span>
                </li>
              ))}
            </ul>
          </li>
        ) : null}
      </ol>
    );
  }

  function renderMain() {
    if (phase.kind === "choose") {
      return (
        <div className="history__state">
          <Icon name="template" size={20} />
          <p>{templates.length > 0 ? "选一个模板，点「开始规整」。" : "还没有模板，先在「笔记模板」里建一个。"}</p>
          <p className="history__hint">正文会切成块发给 AI，AI 只回「哪块放进哪个小节」，正文由应用逐字搬过去。</p>
        </div>
      );
    }
    if (phase.kind === "running") {
      return (
        <div className="history__state" role="status">
          <span className="arrange__spinner" aria-hidden="true" />
          <p>AI 正在分配小节…</p>
          <p className="history__hint">AI 只回编号，不会改正文里的字。</p>
        </div>
      );
    }
    if (phase.kind === "error") {
      return (
        <div className="history__state history__state--error" role="alert">
          <p>规整没成功：{phase.message}</p>
          <p className="history__hint">笔记没有任何改动。可以重试，或者换个模板 / 模型。</p>
        </div>
      );
    }
    return (
      <div className="arrange__body">
        <div className="arrange__summary">{renderSummary(phase.result)}</div>
        <div className="arrange__diff">
          {diff ? (
            <p className="history__legend">
              规整前后：
              {diff.stats.added > 0 ? <span className="history__plus">+{diff.stats.added} 行</span> : null}
              {diff.stats.removed > 0 ? <span className="history__minus">−{diff.stats.removed} 行</span> : null}
              <span className="history__legendhint">（块只是换了位置，字没有改）</span>
            </p>
          ) : null}
          <div className="history__scroll">{diff ? <DiffView rows={diff.rows} label="规整前后的逐行对比" /> : null}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="overlay overlay--right" role="presentation" onMouseDown={onClose}>
      <div
        className="history arrange"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="按模板规整"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="history__head">
          <span className="history__icon" aria-hidden="true">
            <Icon name="template" size={17} />
          </span>
          <div className="history__heading">
            <h2>按模板规整</h2>
            <span className="history__sub">{noteTitle || "未命名"}</span>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭按模板规整" title="关闭（Esc）">
            <Icon name="x" size={17} />
          </button>
        </header>

        <div className="history__toolbar arrange__toolbar">
          <label className="arrange__pick">
            <span>模板</span>
            <select
              className="arrange__select"
              value={activeTemplate}
              disabled={busy || templates.length === 0}
              onChange={(event) => {
                setChoice(event.target.value);
                if (phase.kind !== "choose") setPhase({ kind: "choose" });
              }}
              aria-label="规整用的模板"
            >
              {templates.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {busy ? (
            <button type="button" className="btn btn--small" onClick={cancel}>
              取消
            </button>
          ) : (
            <button
              type="button"
              className={`btn btn--small${phase.kind === "done" ? "" : " btn--primary"}`}
              disabled={!activeTemplate}
              onClick={() => void start(activeTemplate)}
            >
              {phase.kind === "choose" ? "开始规整" : "重新规整"}
            </button>
          )}
        </div>

        <div className="history__content arrange__content">{renderMain()}</div>

        <footer className="history__foot">
          <span className="history__foothint">正文每个字都来自原文；应用后可以「撤销 AI 改写」或 Ctrl+Z。</span>
          <div className="history__actions">
            <button type="button" className="btn btn--small" onClick={onClose}>
              不用了
            </button>
            <button
              type="button"
              className="btn btn--small btn--primary"
              disabled={!result}
              onClick={() => result && onApply(result)}
            >
              应用
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
