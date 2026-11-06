import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import * as api from "../api.ts";
import type { CaptureResult } from "../api.ts";

type Props = {
  open: boolean;
  onClose: () => void;
  onCaptured: (result: CaptureResult) => void;
};

type Status = "idle" | "submitting" | "ok" | "error";

function parseTags(raw: string): string[] {
  return raw
    .split(/[,，\s]+/)
    .map((tag) => tag.replace(/^#/, "").trim())
    .filter(Boolean);
}

export default function CaptureModal({ open, onClose, onCaptured }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const closeTimer = useRef<number | null>(null);
  const [text, setText] = useState("");
  const [tags, setTags] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setText("");
    setTags("");
    setStatus("idle");
    setError(null);
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    return () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    };
  }, []);

  async function submit(): Promise<void> {
    if (status === "submitting" || status === "ok") return;
    const trimmed = text.trim();
    if (!trimmed) {
      setError("先写点什么再收。");
      textareaRef.current?.focus();
      return;
    }
    setStatus("submitting");
    setError(null);
    try {
      const result = await api.capture(trimmed, parseTags(tags));
      setStatus("ok");
      onCaptured(result);
      closeTimer.current = window.setTimeout(() => {
        closeTimer.current = null;
        onClose();
      }, 400);
    } catch (err) {
      setStatus("error");
      setError(api.errorMessage(err));
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement | HTMLInputElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      if (status !== "submitting") onClose();
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  }

  if (!open) return null;

  return (
    <div
      className="overlay overlay--center"
      role="presentation"
      onMouseDown={() => {
        if (status !== "submitting") onClose();
      }}
    >
      <div
        className="capture"
        role="dialog"
        aria-modal="true"
        aria-label="快速捕获"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="capture__head">
          <h2>记一条想法</h2>
          <span className="capture__hint">进收件箱（inbox），之后再整理</span>
        </div>

        {status === "ok" ? (
          <div className="capture__success" role="status">
            已收进 inbox
          </div>
        ) : (
          <>
            <textarea
              ref={textareaRef}
              className="capture__textarea"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="刚才想到什么？一句话也行。"
              aria-label="想法内容"
              spellCheck={false}
            />
            <input
              className="capture__tags"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="标签，用空格或逗号分隔（可留空）"
              aria-label="标签"
              spellCheck={false}
            />
            {error ? (
              <p className="capture__error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="capture__foot">
              <span className="capture__keys">
                <kbd>Ctrl</kbd>
                <kbd>Enter</kbd> 收下 · <kbd>Esc</kbd> 取消
              </span>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void submit()}
                disabled={status === "submitting"}
              >
                {status === "submitting" ? "收集中…" : "收下"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
