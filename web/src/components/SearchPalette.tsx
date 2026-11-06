import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import * as api from "../api.ts";
import type { SearchHit } from "../api.ts";

type Props = {
  open: boolean;
  onClose: () => void;
  onOpenNote: (id: string) => void;
};

export default function SearchPalette({ open, onClose, onOpenNote }: Props) {
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

  function handleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (items.length > 0) setActive((current) => (current + 1) % items.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length > 0) setActive((current) => (current - 1 + items.length) % items.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const hit = items[active];
      if (hit) {
        onOpenNote(hit.id);
        onClose();
      }
    }
  }

  if (!open) return null;

  return (
    <div className="overlay overlay--center" onMouseDown={onClose} role="presentation">
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="搜索笔记"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="palette__inputrow">
          <span className="palette__icon" aria-hidden="true">
            ⌕
          </span>
          <input
            ref={inputRef}
            className="palette__input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索笔记标题与正文…"
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
          {!loading && !error && query.trim() && items.length === 0 ? (
            <p className="palette__state">没有找到「{query.trim()}」。</p>
          ) : null}
          {!query.trim() ? (
            <p className="palette__state palette__state--dim">
              输入关键词开始检索。中文两个字也能搜到。
            </p>
          ) : null}

          {items.map((hit, index) => (
            <button
              key={hit.id}
              type="button"
              role="option"
              aria-selected={index === active}
              className={`hit${index === active ? " is-active" : ""}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => {
                onOpenNote(hit.id);
                onClose();
              }}
            >
              <span className="hit__head">
                <span className="hit__title">{hit.title || "未命名"}</span>
                <span className="hit__path">{hit.relPath}</span>
              </span>
              {/* snippet 已由服务端转义并加好 <mark>，可直接渲染。 */}
              <span className="hit__snippet" dangerouslySetInnerHTML={{ __html: hit.snippet }} />
            </button>
          ))}
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
