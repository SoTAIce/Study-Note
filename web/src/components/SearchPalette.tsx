import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useDialogFocus } from "../lib/use-dialog-focus.ts";
import * as api from "../api.ts";
import type { SearchHit } from "../api.ts";
import Icon from "./Icon.tsx";

/** 输入关键词就出现在结果最上面的命令（例如输入「模板」打开模板管理，tpl-001） */
export type PaletteCommand = { id: string; label: string; keywords: string[]; run: () => void };

type Props = {
  open: boolean;
  onClose: () => void;
  onOpenNote: (id: string) => void;
  commands?: PaletteCommand[];
  /** 还没输入时列出的几篇（例如分屏时「上次在右边看的」，read-002） */
  suggestions?: Array<{ id: string; title: string; hint: string }>;
  /** 弹框的名字和输入框提示（默认是「搜索笔记」） */
  label?: string;
  placeholder?: string;
};

/** 命令匹配：关键词包含输入，或输入包含关键词（不区分大小写） */
export function matchCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return commands.filter((command) =>
    command.keywords.some((keyword) => {
      const k = keyword.toLowerCase();
      return k.includes(q) || q.includes(k);
    }),
  );
}

export default function SearchPalette({
  open,
  onClose,
  onOpenNote,
  commands = [],
  suggestions = [],
  label = "搜索笔记",
  placeholder = "搜索笔记标题与正文…",
}: Props) {
  const dialogFocusRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogFocusRef, open);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setItems([]);
    setActive(0);
    setError(null);
    setLoading(false);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setItems([]);
      setLoading(false);
      setError(null);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    const timer = window.setTimeout(() => {
      api
        .searchNotes(trimmed, { limit: 30 })
        .then((res) => {
          if (seqRef.current !== seq) return;
          setItems(res.items);
          setActive(0);
          setError(null);
        })
        .catch((err: unknown) => {
          if (seqRef.current !== seq) return;
          setItems([]);
          setError(api.errorMessage(err));
        })
        .finally(() => {
          if (seqRef.current === seq) setLoading(false);
        });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const matched = matchCommands(commands, query);
  const suggested = query.trim() ? [] : suggestions;
  const total = suggested.length + matched.length + items.length;

  function runAt(index: number): void {
    if (suggested.length > 0) {
      const pick = suggested[index];
      if (pick) {
        onOpenNote(pick.id);
        onClose();
      }
      return;
    }
    const command = matched[index];
    if (command) {
      onClose();
      command.run();
      return;
    }
    const hit = items[index - matched.length];
    if (hit) {
      onOpenNote(hit.id);
      onClose();
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (total > 0) setActive((current) => (current + 1) % total);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (total > 0) setActive((current) => (current - 1 + total) % total);
    } else if (event.key === "Enter") {
      event.preventDefault();
      runAt(active);
    }
  }

  if (!open) return null;

  return (
    <div className="overlay overlay--center" onMouseDown={onClose} role="presentation">
      <div
        className="palette"
        ref={dialogFocusRef} role="dialog"
        aria-modal="true"
        aria-label={label}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="palette__inputrow">
          <span className="palette__icon" aria-hidden="true">
            <Icon name="search" size={17} />
          </span>
          <input
            ref={inputRef}
            className="palette__input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            aria-label="搜索关键词"
            spellCheck={false}
            autoComplete="off"
          />
          <kbd>Esc</kbd>
        </div>

        <div className="palette__results" role="listbox" aria-label="检索结果">
          {loading && items.length === 0 ? <p className="palette__state">检索中…</p> : null}
          {error ? (
            <p className="palette__state palette__state--error" role="alert">
              检索失败：{error}
            </p>
          ) : null}
          {matched.map((command, index) => (
            <button
              key={command.id}
              type="button"
              role="option"
              aria-selected={index === active}
              className={`hit hit--command${index === active ? " is-active" : ""}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => runAt(index)}
            >
              <span className="hit__head">
                <span className="hit__title">{command.label}</span>
                <span className="hit__path">命令</span>
              </span>
            </button>
          ))}
          {!loading && !error && query.trim() && items.length === 0 && matched.length === 0 ? (
            <p className="palette__state">没有找到「{query.trim()}」。</p>
          ) : null}
          {suggested.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={index === active}
              className={`hit hit--command${index === active ? " is-active" : ""}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => runAt(index)}
            >
              <span className="hit__head">
                <span className="hit__title">{item.title || "未命名"}</span>
                <span className="hit__path">{item.hint}</span>
              </span>
            </button>
          ))}
          {!query.trim() ? (
            <p className="palette__state palette__state--dim">
              输入关键词开始检索。中文两个字也能搜到。
            </p>
          ) : null}

          {items.map((hit, at) => {
            const index = at + matched.length;
            return (
            <button
              key={hit.id}
              type="button"
              role="option"
              aria-selected={index === active}
              className={`hit${index === active ? " is-active" : ""}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => runAt(index)}
            >
              <span className="hit__head">
                <span className="hit__title">{hit.title || "未命名"}</span>
                <span className="hit__path">{hit.relPath}</span>
              </span>
              {/* snippet 已由服务端转义并加好 <mark>，可直接渲染。 */}
              <span className="hit__snippet" dangerouslySetInnerHTML={{ __html: hit.snippet }} />
            </button>
            );
          })}
        </div>

        <div className="palette__foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 选择
          </span>
          <span>
            <kbd>Enter</kbd> 打开
          </span>
          <span>
            <kbd>Esc</kbd> 关闭
          </span>
        </div>
      </div>
    </div>
  );
}
