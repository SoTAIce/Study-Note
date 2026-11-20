import { useEffect, useMemo, useRef, useState } from "react";
import { isTopDialog } from "../lib/focus-trap.ts";
import { previewLines, previewMarkdown, referencesLocalImages } from "../lib/md-import.ts";
import { useDialogFocus } from "../lib/use-dialog-focus.ts";
import Icon from "./Icon.tsx";

/**
 * 导入笔记（import-001）：拖进来一个 .md 后弹出。确认标题和分组，看一眼开头和会保留的文件头，再导入。
 * 真正写盘在服务端（POST /api/notes/import），由 App 的 onImport 发请求、打开新笔记。
 */
type Props = {
  fileName: string;
  content: string;
  /** 拖进来的其它 .md 个数（一次只导一个） */
  skipped: number;
  groups: string[];
  /** 预选的分组；null = 不分组 */
  initialGroup: string | null;
  onImport: (input: { title: string; group: string | null }) => Promise<string | null>;
  onClose: () => void;
};

export default function ImportDialog({ fileName, content, skipped, groups, initialGroup, onImport, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef);
  const preview = useMemo(() => previewMarkdown(fileName, content), [fileName, content]);
  const [title, setTitle] = useState(preview.title);
  const [group, setGroup] = useState(initialGroup ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // 分组下拉里一定要有预选的那个（比如刚拖到一个新建的子项目上）
  const options = useMemo(() => {
    const list = [...groups];
    if (initialGroup && !list.some((name) => name.toLowerCase() === initialGroup.toLowerCase())) list.unshift(initialGroup);
    return list;
  }, [groups, initialGroup]);

  useEffect(() => {
    const timer = window.setTimeout(() => titleRef.current?.select(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || !isTopDialog(dialog) || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function submit(): Promise<void> {
    if (busy) return;
    if (!title.trim()) {
      setError("标题不能为空");
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await onImport({ title: title.trim(), group: group || null });
    if (failure) {
      setError(failure);
      setBusy(false);
    }
  }

  const head = previewLines(preview.body);
  const localImages = referencesLocalImages(preview.body);

  return (
    <div className="overlay overlay--center overlay--top" role="presentation" onMouseDown={() => !busy && onClose()}>
      <div
        className="import-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="导入笔记"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings__head">
          <h2>导入笔记</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭导入笔记" disabled={busy}>
            <Icon name="x" size={14} />
          </button>
        </header>

        <p className="import-dialog__file">
          <Icon name="notes" size={13} /> {fileName}
        </p>
        {skipped > 0 ? (
          <p className="settings__tip" role="note">
            一次只导一个，这次导入《{fileName}》，另外 {skipped} 个没有导入。
          </p>
        ) : null}

        <form
          className="import-dialog__form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="field">
            <span>标题</span>
            <input ref={titleRef} value={title} onChange={(event) => setTitle(event.target.value)} aria-label="导入后的标题" disabled={busy} />
          </label>
          <label className="field">
            <span>放进哪个分组</span>
            <select value={group} onChange={(event) => setGroup(event.target.value)} aria-label="导入到的分组" disabled={busy}>
              <option value="">不分组</option>
              {options.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>

          <div className="import-dialog__preview">
            <span className="tpl-panel__preview-label">正文开头</span>
            <pre aria-label="正文开头">{head || "（正文是空的）"}</pre>
          </div>
          {preview.keptKeys.length > 0 ? (
            <p className="import-dialog__kept">
              文件头里这些会原样保留：
              {preview.keptKeys.map((key) => (
                <code key={key}>{key}</code>
              ))}
            </p>
          ) : null}
          {localImages ? <p className="settings__tip">文件里引用的本地图片不会一起导入，导入后这些图片显示不出来。</p> : null}

          {error ? (
            <p className="settings__error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="settings__foot">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy ? "导入中…" : "导入"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
