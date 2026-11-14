import { useEffect, useState } from "react";
import type { KeyboardEvent, RefObject, SyntheticEvent } from "react";
import Preview from "./Preview.tsx";
import type { ConflictInfo, NoteDetail } from "../api.ts";
import { relativeTime } from "../lib/time.ts";
import type { ViewMode } from "../lib/theme.ts";
import Icon, { type IconName } from "./Icon.tsx";
import { continueList, indent, makeLink, toggleWrap, type Edit } from "../lib/edit-ops.ts";
import { applyEditUndoable } from "../lib/textarea-edit.ts";

/** 正文框里的编辑键（editor-001）：Tab 缩进、回车续列表、Ctrl+B / I / K */
function editForKey(event: KeyboardEvent<HTMLTextAreaElement>): { edit: Edit | null; handled: boolean } {
  const target = event.currentTarget;
  const state = { value: target.value, start: target.selectionStart, end: target.selectionEnd };
  const ctrl = event.ctrlKey || event.metaKey;
  if (event.key === "Tab" && !ctrl && !event.altKey) {
    // 退到顶格时 edit 为 null 也拦下，不让焦点跳出正文框
    return { edit: indent(state, event.shiftKey), handled: true };
  }
  if (event.key === "Enter" && !ctrl && !event.altKey && !event.shiftKey) {
    const edit = continueList(state);
    return { edit, handled: edit !== null };
  }
  if (ctrl && !event.altKey && !event.shiftKey) {
    const key = event.key.toLowerCase();
    if (key === "b") return { edit: toggleWrap(state, "**"), handled: true };
    if (key === "i") return { edit: toggleWrap(state, "*"), handled: true };
    if (key === "k") {
      // 没选中文字时不接管：Ctrl+K 照旧打开搜索
      const edit = makeLink(state);
      return { edit, handled: edit !== null };
    }
  }
  return { edit: null, handled: false };
}

const VIEW_OPTIONS: Array<{ mode: ViewMode; icon: IconName; label: string }> = [
  { mode: "write", icon: "pen", label: "只写" },
  { mode: "split", icon: "columns", label: "分栏" },
  { mode: "preview", icon: "eye", label: "只看预览" },
];

export type SaveStatus = "idle" | "saving" | "saved" | "dirty" | "error" | "conflict";

const STATUS_TEXT: Record<SaveStatus, string> = {
  idle: "",
  saving: "保存中…",
  saved: "已保存",
  dirty: "未保存",
  error: "保存失败",
  conflict: "有冲突",
};

const TYPE_LABEL: Record<NoteDetail["meta"]["type"], string> = {
  note: "笔记",
  idea: "想法",
  source: "来源",
};

type Props = {
  note: NoteDetail;
  title: string;
  body: string;
  tags: string[];
  /** 已有分组，供输入框联想 */
  groups: string[];
  /**
   * 把这篇笔记移到某个组（null = 移出分组）。
   * 返回值表示是否成功；失败时输入框要还原成磁盘上的组名。
   */
  onMoveToGroup: (group: string | null) => Promise<boolean>;
  status: SaveStatus;
  saveError: string | null;
  conflict: ConflictInfo | null;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  railOpen: boolean;
  onChangeTitle: (value: string) => void;
  onChangeBody: (value: string) => void;
  onSaveNow: () => void;
  onRetrySave: () => void;
  onDelete: () => void;
  onToggleRail: () => void;
  onResolveOverwrite: () => void;
  onResolveReload: () => void;
  onOpenWikilink: (target: string) => void;
  onFilterTag: (tag: string) => void;
  onSelectionChange: (length: number) => void;
  /** 回到首页（欢迎界面），那里是「新建笔记」的入口。 */
  onGoHome: () => void;
  /** 打开阅览模式（只读、铺满窗口）。 */
  onOpenPreviewFull: () => void;
  /** 打开「导出 PDF」面板 */
  onExport: () => void;
  /** 上一次「整篇替换」是否还能撤销。 */
  aiUndoAvailable: boolean;
  onUndoAiReplace: () => void;
  viewMode: ViewMode;
  onViewMode: (mode: ViewMode) => void;
  /** 打开历史版本面板 */
  onOpenHistory: () => void;
};

export default function EditorPane({
  note,
  title,
  body,
  tags,
  groups,
  onMoveToGroup,
  status,
  saveError,
  conflict,
  textareaRef,
  railOpen,
  onChangeTitle,
  onChangeBody,
  onSaveNow,
  onRetrySave,
  onDelete,
  onToggleRail,
  onResolveOverwrite,
  onResolveReload,
  onOpenWikilink,
  onFilterTag,
  onSelectionChange,
  onGoHome,
  onOpenPreviewFull,
  onExport,
  aiUndoAvailable,
  onUndoAiReplace,
  viewMode,
  onViewMode,
  onOpenHistory,
}: Props) {
  const lines = body ? body.split("\n").length : 0;
  const [groupDraft, setGroupDraft] = useState(note.meta.group ?? "");

  // 切到别的笔记 / 外部改了分组时，输入框要跟着变（否则会显示上一篇的组名）
  useEffect(() => {
    setGroupDraft(note.meta.group ?? "");
  }, [note.id, note.meta.group]);

  async function commitGroup(): Promise<void> {
    const next = groupDraft.trim();
    const current = (note.meta.group ?? "").trim();
    if (next === current) {
      setGroupDraft(current);
      return;
    }
    const ok = await onMoveToGroup(next ? next : null);
    // 失败（比如组名非法、磁盘被外部改动）就别让输入框停在跟文件不一致的内容上
    if (!ok) setGroupDraft(note.meta.group ?? "");
  }

  function handleTitleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      textareaRef.current?.focus();
    }
  }

  function handleBodyKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // 输入法正在组字（中文输入时回车是上屏）：一律不管
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const { edit, handled } = editForKey(event);
    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
    if (edit) applyEditUndoable(event.currentTarget, edit);
  }

  function reportSelection(event: SyntheticEvent<HTMLTextAreaElement>): void {
    const target = event.currentTarget;
    onSelectionChange(Math.max(0, target.selectionEnd - target.selectionStart));
  }

  return (
    <div className="editor">
      <header className="editor__head">
        <div className="editor__titlewrap">
          <input
            className="editor__title"
            value={title}
            onChange={(event) => onChangeTitle(event.target.value)}
            onKeyDown={handleTitleKeyDown}
            placeholder="无标题"
            aria-label="笔记标题"
            spellCheck={false}
          />
          <div className="editor__meta">
            <span className={`type-badge type-badge--${note.meta.type}`}>{TYPE_LABEL[note.meta.type]}</span>
            <span className="editor__updated">
              <Icon name="clock" size={12} />
              更新于 {relativeTime(note.meta.updated)}
            </span>
            <label className="editor__group" title="把这篇文章归到某个分组（只改组名，不改笔记内容，也不改更新时间）">
              <Icon name="folder" size={12} />
              <span className="sr-only">分组</span>
              <input
                className="editor__group-input"
                value={groupDraft}
                onChange={(event) => setGroupDraft(event.target.value)}
                onBlur={() => commitGroup()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    setGroupDraft(note.meta.group ?? "");
                    event.currentTarget.blur();
                  }
                }}
                list="editor-group-options"
                placeholder="未分组"
                spellCheck={false}
                aria-label="笔记分组"
              />
              <datalist id="editor-group-options">
                {groups.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </label>
            <span className="editor__tags" aria-label="标签">
              {tags.length === 0 ? (
                <span className="tagline__hint">正文里写 #标签 自动归类</span>
              ) : (
                tags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="tagline__chip"
                    onClick={() => onFilterTag(tag)}
                    title={`筛选 #${tag}`}
                  >
                    #{tag}
                  </button>
                ))
              )}
            </span>
          </div>
        </div>

        <div className="editor__actions">
          <span className={`save-state save-state--${status}`} aria-live="polite">
            <span className="save-state__dot" aria-hidden="true" />
            {STATUS_TEXT[status]}
          </span>
          {aiUndoAvailable ? (
            <button
              type="button"
              className="btn btn--small btn--undo"
              onClick={onUndoAiReplace}
              title="恢复 AI 整篇替换之前的正文"
            >
              <Icon name="undo" size={13} />
              撤销 AI 改写
            </button>
          ) : null}
          <div className="segmented" role="group" aria-label="编辑视图">
            {VIEW_OPTIONS.map((option) => (
              <button
                key={option.mode}
                type="button"
                className={`segmented__btn${viewMode === option.mode ? " is-active" : ""}`}
                onClick={() => onViewMode(option.mode)}
                aria-pressed={viewMode === option.mode}
                title={option.label}
                aria-label={option.label}
              >
                <Icon name={option.icon} size={14} />
              </button>
            ))}
          </div>
          <span className="editor__divider" aria-hidden="true" />
          <button type="button" className="icon-btn" onClick={onGoHome} title="回到首页" aria-label="回到首页">
            <Icon name="home" size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={onOpenPreviewFull}
            title="阅览模式（Ctrl+Shift+F）"
            aria-label="阅览模式"
          >
            <Icon name="book" size={16} />
          </button>
          <button type="button" className="icon-btn" onClick={onExport} title="导出 PDF" aria-label="导出 PDF">
            <Icon name="download" size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={onOpenHistory}
            title="历史版本（Ctrl+Shift+H）"
            aria-label="历史版本"
          >
            <Icon name="history" size={16} />
          </button>
          <button type="button" className="icon-btn" onClick={onSaveNow} title="立即保存（Ctrl+S）" aria-label="立即保存">
            <Icon name="save" size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={onToggleRail}
            aria-pressed={railOpen}
            title={railOpen ? "收起关联与 AI 面板" : "展开关联与 AI 面板（Ctrl+J）"}
            aria-label="关联与 AI 面板"
          >
            <Icon name="panelRight" size={16} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--danger"
            onClick={onDelete}
            title="删除（移入回收站）"
            aria-label="删除笔记"
          >
            <Icon name="trash" size={16} />
          </button>
        </div>
      </header>

      {conflict ? (
        <div className="conflict" role="alert">
          <div className="conflict__text">
            <strong>文件已被外部修改</strong>
            <span>
              磁盘上的版本在 {relativeTime(conflict.diskUpdated)} 变了，你的修改还没保存。
              要覆盖磁盘版本，还是丢掉本地修改重新加载？
            </span>
          </div>
          <div className="conflict__actions">
            <button type="button" className="btn btn--small btn--warn" onClick={onResolveOverwrite}>
              以我的覆盖
            </button>
            <button type="button" className="btn btn--small" onClick={onResolveReload}>
              重新加载
            </button>
          </div>
        </div>
      ) : null}

      {status === "error" && saveError ? (
        <div className="error-bar" role="alert">
          <span>保存失败：{saveError}</span>
          <button type="button" className="btn btn--small" onClick={onRetrySave}>
            重试
          </button>
        </div>
      ) : null}

      <div className={`split split--${viewMode}`}>
        <div className="split__pane split__pane--write">
          <textarea
            ref={textareaRef}
            className="editor__textarea"
            value={body}
            onChange={(event) => onChangeBody(event.target.value)}
            onKeyDown={handleBodyKeyDown}
            onSelect={reportSelection}
            onKeyUp={reportSelection}
            onMouseUp={reportSelection}
            placeholder={"在这里记。Markdown、[[双链]]、#标签 都支持。\nCtrl+S 立即保存，离开会自动保存。"}
            aria-label="笔记正文"
            spellCheck={false}
            autoComplete="off"
          />
        </div>
        <div className="split__pane split__pane--preview">
          <Preview markdown={body} onOpenWikilink={onOpenWikilink} onFilterTag={onFilterTag} />
        </div>
      </div>

      <footer className="editor__foot">
        <span className="editor__path" title={note.relPath}>
          <Icon name="notes" size={12} />
          {note.relPath}
        </span>
        <span className="editor__stats">
          {lines} 行 · {body.length} 字 · 约 {Math.max(1, Math.round(body.length / 400))} 分钟读完 · 自动保存
        </span>
      </footer>
    </div>
  );
}
