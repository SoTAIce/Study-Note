import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

type Props = {
  busy: boolean;
  error: string | null;
  /** 可选的已有分组 */
  groups: string[];
  onCancel: () => void;
  onCreate: (input: { title: string; body: string; group: string | null }) => void;
};

/**
 * 新建笔记页：真正的「新建 → 书写 → 落盘」分离。
 * 这里什么都不写磁盘，点「创建并开始编辑」才 POST /api/notes；
 * 取消则整页丢弃（不会留下「未命名」的空笔记）。
 */
export default function ComposeView({ busy, error, groups, onCancel, onCreate }: Props) {
  const [title, setTitle] = useState("");
  const [group, setGroup] = useState("");
  const [body, setBody] = useState("");
  const titleRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  function submit(): void {
    if (busy) return;
    onCreate({ title: title.trim(), body, group: group.trim() ? group.trim() : null });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!busy) onCancel();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      submit();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === "s" || event.key === "S")) {
      event.preventDefault();
      submit();
    }
  }

  function handleTitleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      bodyRef.current?.focus();
    }
  }

  const lines = body ? body.split("\n").length : 0;

  return (
    <div className="compose" onKeyDown={handleKeyDown}>
      <header className="compose__head">
        <div className="compose__heading">
          <span className="compose__kicker">新建笔记</span>
          <span className="compose__sub">写好了再创建；取消就什么都不留</span>
        </div>
        <div className="compose__actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            取消 <kbd>Esc</kbd>
          </button>
          <button type="button" className="btn btn--primary" onClick={submit} disabled={busy}>
            {busy ? "创建中…" : "创建并开始编辑"} <kbd>Ctrl Enter</kbd>
          </button>
        </div>
      </header>

      <div className="compose__fields">
        <input
          ref={titleRef}
          className="compose__title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={handleTitleKeyDown}
          placeholder="标题（不写也行，会从正文第一行取）"
          aria-label="新笔记标题"
          spellCheck={false}
        />
        <div className="compose__group">
          <label className="compose__group-label" htmlFor="compose-group">
            分组
          </label>
          <input
            id="compose-group"
            className="compose__group-input"
            value={group}
            onChange={(event) => setGroup(event.target.value)}
            list="compose-group-options"
            placeholder="不填就是未分组；填新的会自动建组"
            spellCheck={false}
          />
          <datalist id="compose-group-options">
            {groups.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
        <textarea
          ref={bodyRef}
          className="compose__body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder={"正文。支持 Markdown、[[双链]]、#标签。\n\n例：\n# 位置编码\n\n- 问题：注意力本身不含顺序信息\n- 做法：给每个位置一个可学习的向量"}
          aria-label="新笔记正文"
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      {error ? (
        <p className="compose__error" role="alert">
          创建失败：{error}
        </p>
      ) : null}

      <footer className="compose__foot">
        <span className="compose__hint">
          {lines} 行 · {body.length} 字 · 标签在正文里写 #标签 就会自动归类
        </span>
      </footer>
    </div>
  );
}
