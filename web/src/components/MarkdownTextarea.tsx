import { useLayoutEffect, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent, KeyboardEvent, RefObject, SyntheticEvent } from "react";
import { errorMessage, listNotes, uploadAttachment } from "../api.ts";
import { imageInsertText, pickImages } from "../lib/attachments.ts";
import { caretCoords } from "../lib/caret-coords.ts";
import { continueList, indent, makeLink, pasteLink, toggleWrap, type Edit } from "../lib/edit-ops.ts";
import { applyEditUndoable } from "../lib/textarea-edit.ts";
import { completeWikilink, rankTitles, wikilinkQuery, type WikilinkQuery } from "../lib/wikilink-complete.ts";

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

type Suggest = {
  query: WikilinkQuery;
  items: string[];
  active: number;
  left: number;
  top: number;
  /** 下面放不下就显示在光标上方 */
  flip: boolean;
  anchorTop: number;
};

type Props = {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  /** 贴图存到这篇笔记的附件里 */
  noteId: string;
  /** 自己的标题：[[ 补全时不列出自己 */
  selfTitle: string;
  onNotify: (text: string, kind: "info" | "ok" | "error") => void;
  className: string;
  placeholder?: string;
  ariaLabel: string;
  /** 高度跟着内容长（连读里就地编辑用），不在框里滚动 */
  autoSize?: boolean;
  /** 内置按键（补全、Tab、续列表、Ctrl+B/I/K）没处理的键，再交给调用方 */
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSelectionChange?: (length: number) => void;
  /** 粘贴了一段普通文字（不是图片、不是选中后贴网址）：给 App 判断要不要提示规整（tpl-002） */
  onLargePaste?: (pasted: string, before: string) => void;
  onScroll?: () => void;
};

/**
 * Markdown 正文框：编辑器（EditorPane）和连读里的就地编辑（book-002）共用。
 * 包含快捷键（editor-001）、[[ 补全（editor-003）、粘贴网址变链接（editor-007）、贴图 / 拖图上传（media-001）。
 */
export default function MarkdownTextarea({
  textareaRef,
  value,
  onChange,
  noteId,
  selfTitle,
  onNotify,
  className,
  placeholder,
  ariaLabel,
  autoSize,
  onKeyDown,
  onSelectionChange,
  onLargePaste,
  onScroll,
}: Props) {
  // —— 输入 [[ 补全标题（editor-003）——
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const titlesRef = useRef<{ at: number; titles: string[] } | null>(null);
  const loadingTitles = useRef(false);
  /** 按了 Esc 的那个 [[ 不再弹 */
  const dismissedAt = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!autoSize) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight + 2}px`;
  }, [autoSize, value, textareaRef]);

  function closeSuggest(): void {
    setSuggest(null);
  }

  function updateSuggest(textarea: HTMLTextAreaElement): void {
    const caret = textarea.selectionStart;
    const query = textarea.selectionEnd === caret ? wikilinkQuery(textarea.value, caret) : null;
    if (!query || query.start === dismissedAt.current) {
      if (!query) dismissedAt.current = null;
      setSuggest(null);
      return;
    }
    const cache = titlesRef.current;
    if (!cache || Date.now() - cache.at > 15_000) {
      if (!loadingTitles.current) {
        loadingTitles.current = true;
        listNotes()
          .then((res) => {
            titlesRef.current = { at: Date.now(), titles: res.items.map((item) => item.title) };
            if (document.activeElement === textarea) updateSuggest(textarea);
          })
          .catch(() => undefined)
          .finally(() => {
            loadingTitles.current = false;
          });
      }
      if (!cache) return;
    }
    const items = rankTitles(cache.titles, query.query, selfTitle.trim() || null);
    if (items.length === 0) {
      setSuggest(null);
      return;
    }
    const box = textarea.getBoundingClientRect();
    const at = caretCoords(textarea, query.start);
    const below = box.top + at.top + at.height + 4;
    const room = window.innerHeight - below;
    setSuggest((previous) => ({
      query,
      items,
      active:
        previous && previous.query.start === query.start && previous.query.query === query.query
          ? Math.min(previous.active, items.length - 1)
          : 0,
      left: Math.max(8, Math.min(box.left + at.left, window.innerWidth - 288)),
      top: below,
      flip: room < 220,
      anchorTop: box.top + at.top - 4,
    }));
  }

  function acceptSuggest(textarea: HTMLTextAreaElement, picked: string): void {
    if (!suggest) return;
    const edit = completeWikilink(textarea.value, suggest.query, textarea.selectionStart, picked);
    setSuggest(null);
    applyEditUndoable(textarea, edit);
  }

  /** 补全列表开着时的按键：↑ ↓ 选，回车 / Tab 补全，Esc 关掉。处理了返回 true */
  function handleSuggestKey(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!suggest || event.ctrlKey || event.metaKey || event.altKey) return false;
    const count = suggest.items.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      setSuggest({ ...suggest, active: (suggest.active + step + count) % count });
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      acceptSuggest(event.currentTarget, suggest.items[suggest.active]);
      return true;
    }
    if (event.key === "Escape") {
      dismissedAt.current = suggest.query.start;
      setSuggest(null);
      return true;
    }
    return false;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // 输入法正在组字（中文输入时回车是上屏）：一律不管
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (handleSuggestKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const { edit, handled } = editForKey(event);
    if (!handled) {
      onKeyDown?.(event);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (edit) applyEditUndoable(event.currentTarget, edit);
  }

  // —— 粘贴 / 拖入图片（media-001）——
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(0);

  // 上传期间切到别的笔记时，不往新笔记里插
  const noteIdRef = useRef(noteId);
  noteIdRef.current = noteId;

  /** 逐张上传，全部完成后在当时的光标处插入（可 Ctrl+Z 撤回）；切走了就不插 */
  async function uploadImages(files: File[]): Promise<void> {
    if (files.length === 0) return;
    const owner = noteId;
    setUploading((n) => n + files.length);
    onNotify(files.length > 1 ? `正在保存 ${files.length} 张图片…` : "正在保存图片…", "info");
    const markdowns: string[] = [];
    let failure: string | null = null;
    for (const file of files) {
      try {
        markdowns.push((await uploadAttachment(owner, file)).markdown);
      } catch (err) {
        failure = errorMessage(err);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    const textarea = textareaRef.current;
    if (markdowns.length > 0 && textarea && noteIdRef.current === owner) {
      const at = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const insert = imageInsertText(markdowns, at > 0 ? textarea.value[at - 1] : "");
      applyEditUndoable(textarea, { from: at, to: end, insert, selStart: at + insert.length, selEnd: at + insert.length });
    }
    if (failure) onNotify(`图片没有保存：${failure}`, "error");
    else onNotify(markdowns.length > 1 ? `已插入 ${markdowns.length} 张图片` : "已插入图片", "ok");
  }

  function takeImages(files: File[], text: string): boolean {
    const { accept, rejected } = pickImages(files, text);
    if (rejected) onNotify(rejected, "error");
    if (accept.length === 0) return Boolean(rejected);
    void uploadImages(accept);
    return true;
  }

  function hasFiles(event: DragEvent<HTMLTextAreaElement>): boolean {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  /** 选中文字后粘贴网址：变成链接（editor-007）；剪贴板里是图片就上传（media-001） */
  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(event.clipboardData.files);
    if (files.length > 0 && takeImages(files, event.clipboardData.getData("text/plain"))) {
      event.preventDefault();
      return;
    }
    const target = event.currentTarget;
    const edit = pasteLink(
      { value: target.value, start: target.selectionStart, end: target.selectionEnd },
      event.clipboardData.getData("text/plain"),
    );
    if (!edit) {
      onLargePaste?.(event.clipboardData.getData("text/plain"), target.value);
      return;
    }
    event.preventDefault();
    applyEditUndoable(target, edit);
  }

  function reportSelection(event: SyntheticEvent<HTMLTextAreaElement>): void {
    if (!onSelectionChange) return;
    const target = event.currentTarget;
    onSelectionChange(Math.max(0, target.selectionEnd - target.selectionStart));
  }

  return (
    <>
      <textarea
        ref={textareaRef}
        className={`${className}${dragging ? " is-dropping" : ""}`}
        aria-busy={uploading > 0 || undefined}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          updateSuggest(event.target);
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onDragOver={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          if (!dragging) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          setDragging(false);
          const files = Array.from(event.dataTransfer.files);
          if (files.length === 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          takeImages(files, "");
        }}
        onSelect={reportSelection}
        onKeyUp={(event) => {
          reportSelection(event);
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) updateSuggest(event.currentTarget);
        }}
        onMouseUp={(event) => {
          reportSelection(event);
          updateSuggest(event.currentTarget);
        }}
        onScroll={() => {
          if (suggest) closeSuggest();
          onScroll?.();
        }}
        onBlur={closeSuggest}
        placeholder={placeholder}
        aria-label={ariaLabel}
        spellCheck={false}
        autoComplete="off"
      />
      {suggest ? (
        <ul
          className="wikisuggest"
          role="listbox"
          aria-label="链接到笔记"
          style={
            suggest.flip
              ? { left: suggest.left, bottom: window.innerHeight - suggest.anchorTop }
              : { left: suggest.left, top: suggest.top }
          }
        >
          {suggest.items.map((item, index) => (
            <li
              key={item}
              role="option"
              aria-selected={index === suggest.active}
              className={`wikisuggest__item${index === suggest.active ? " is-active" : ""}`}
              // 按下时不让正文框失焦，否则列表先被 onBlur 关掉
              onMouseDown={(event) => {
                event.preventDefault();
                if (textareaRef.current) acceptSuggest(textareaRef.current, item);
              }}
            >
              {item}
            </li>
          ))}
          <li className="wikisuggest__hint" aria-hidden="true">
            ↑ ↓ 选择 · 回车补全 · Esc 关闭
          </li>
        </ul>
      ) : null}
    </>
  );
}
