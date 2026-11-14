import type { Edit } from "./edit-ops.ts";

/**
 * 把一次替换应用到正文框，并让它进浏览器的撤销栈（editor-001 / editor-002）。
 *
 * 用 execCommand("insertText")：它是唯一能让 Ctrl+Z 撤回程序改动的办法。
 * 它作用于「当前有焦点的可编辑元素」，所以先确认焦点真的在这个正文框上
 * （正文框隐藏时 focus 会失败，这时绝不能把文字插进别的输入框）。
 *
 * 返回 true 表示已按撤销栈方式应用；false 表示没动正文框，调用方自己改状态。
 */
export function applyEditUndoable(textarea: HTMLTextAreaElement | null, edit: Edit): boolean {
  if (!textarea || !textarea.isConnected) return false;
  const expected = textarea.value.slice(0, edit.from) + edit.insert + textarea.value.slice(edit.to);
  textarea.focus({ preventScroll: true });
  if (document.activeElement !== textarea) return false;
  textarea.setSelectionRange(edit.from, edit.to);
  try {
    if (edit.insert === "") {
      if (edit.from !== edit.to) document.execCommand("delete", false);
    } else {
      document.execCommand("insertText", false, edit.insert);
    }
  } catch {
    // 下面按结果判断
  }
  if (textarea.value !== expected) {
    // 浏览器不支持或只改了一半：直接写成期望的结果，补一个 input 事件让 React 更新状态
    // 用 setRangeText 而不是给 value 赋值：赋值会被 React 记下，随后的 input 事件就不触发 onChange
    textarea.setRangeText(expected, 0, textarea.value.length);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }
  textarea.setSelectionRange(edit.selStart, edit.selEnd);
  return true;
}
