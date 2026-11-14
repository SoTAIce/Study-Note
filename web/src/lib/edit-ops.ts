/**
 * 编辑器的文本变换（editor-001），全是纯函数：输入「正文 + 选区」，输出一次替换。
 * 组件拿到 Edit 后用浏览器的 insertText 应用，这样 Ctrl+Z 能撤回。
 */

export type TextState = { value: string; start: number; end: number };

/** 把 [from, to) 换成 insert，之后选区为 [selStart, selEnd)（新文本里的位置） */
export type Edit = { from: number; to: number; insert: string; selStart: number; selEnd: number };

const INDENT = 2;
/** 列表项：缩进、标记（- * + 或 1. 1)）、空格、可选的任务框 */
const LIST_RE = /^( *)([-*+]|(\d{1,9})([.)]))( +)(\[[ xX]\] +)?/;
const QUOTE_RE = /^( *>[> ]*)/;

function lineStartAt(value: string, pos: number): number {
  return value.lastIndexOf("\n", pos - 1) + 1;
}

function lineEndAt(value: string, pos: number): number {
  const end = value.indexOf("\n", pos);
  return end === -1 ? value.length : end;
}

function leadingSpaces(line: string): number {
  return /^ */.exec(line)?.[0].length ?? 0;
}

type ListInfo = { indent: number; width: number };

function listInfo(line: string): ListInfo | null {
  const m = LIST_RE.exec(line);
  if (!m) return null;
  return { indent: m[1].length, width: m[2].length + m[5].length };
}

/** 往上找最近的一行非空行 */
function previousNonBlank(lines: string[], index: number): string | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (lines[i].trim() !== "") return lines[i];
  }
  return null;
}

/** 往上找缩进比 indent 小的最近一个列表项（父项） */
function parentListIndent(lines: string[], index: number, indent: number): number | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const info = listInfo(line);
    if (info && info.indent < indent) return info.indent;
    // 顶格的普通段落：列表已经结束了
    if (!info && leadingSpaces(line) === 0) return null;
  }
  return null;
}

/**
 * Tab / Shift+Tab。
 * - 光标在普通行（非列表）且没选中：在光标处插两个空格
 * - 列表行或选中了多行：整行缩进；列表项缩到上一项的内容列（有序列表 3 格），这样 Markdown 才认得出是子项
 * - Shift+Tab：退回父项的缩进，没有父项就退两格
 */
export function indent(state: TextState, outdent: boolean): Edit | null {
  const { value, start, end } = state;
  const blockStart = lineStartAt(value, start);
  // 选区停在下一行行首时，那一行不算选中
  const lastPos = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const blockEnd = lineEndAt(value, lastPos);
  const block = value.slice(blockStart, blockEnd);
  const lines = block.split("\n");
  const firstLine = lines[0];
  const singleLine = lines.length === 1;

  if (!outdent && start === end && singleLine && !listInfo(firstLine)) {
    const insert = " ".repeat(INDENT);
    return { from: start, to: end, insert, selStart: start + INDENT, selEnd: start + INDENT };
  }

  const before = value.slice(0, blockStart).split("\n");
  before.pop(); // 最后一段是空串（blockStart 在行首）
  const context = [...before, firstLine];
  const cur = leadingSpaces(firstLine);
  let delta: number;
  if (!outdent) {
    const prev = previousNonBlank(context, context.length - 1);
    const prevInfo = prev ? listInfo(prev) : null;
    delta = prevInfo && listInfo(firstLine) && cur <= prevInfo.indent ? prevInfo.indent + prevInfo.width - cur : INDENT;
  } else {
    if (cur === 0 && lines.every((line) => leadingSpaces(line) === 0)) return null;
    const parent = listInfo(firstLine) ? parentListIndent(context, context.length - 1, cur) : null;
    delta = parent !== null ? parent - cur : -Math.min(Math.max(cur, 1), INDENT);
  }

  const changes: number[] = [];
  const next = lines.map((line) => {
    if (delta > 0) {
      if (line.trim() === "" && !singleLine) {
        changes.push(0);
        return line;
      }
      changes.push(delta);
      return " ".repeat(delta) + line;
    }
    const remove = Math.min(-delta, leadingSpaces(line));
    changes.push(-remove);
    return line.slice(remove);
  });

  const map = (pos: number): number => {
    let oldLineStart = blockStart;
    let newLineStart = blockStart;
    for (let i = 0; i < lines.length; i += 1) {
      const oldLineEnd = oldLineStart + lines[i].length;
      if (pos <= oldLineEnd) {
        // 行首的位置留在行首：选中整行再缩进，选区仍从行首开始
        if (pos === oldLineStart && changes[i] > 0 && start !== end) return newLineStart;
        return newLineStart + Math.max(0, pos - oldLineStart + changes[i]);
      }
      oldLineStart = oldLineEnd + 1;
      newLineStart += next[i].length + 1;
    }
    return pos + changes.reduce((a, b) => a + b, 0);
  };

  return { from: blockStart, to: blockEnd, insert: next.join("\n"), selStart: map(start), selEnd: map(end) };
}

/** 这一行是否在 ``` / ~~~ 代码块里（数一下前面的围栏行） */
function insideFence(value: string, lineStart: number): boolean {
  let open = false;
  for (const line of value.slice(0, lineStart).split("\n")) {
    if (/^ {0,3}(```|~~~)/.test(line)) open = !open;
  }
  return open;
}

/**
 * 回车：在列表项 / 引用里自动续上标记；有缩进的普通行（代码块里）保持缩进（editor-008）。
 * 代码块里只保持缩进，不续列表标记。
 * - 有序列表编号 +1，任务列表续上「[ ] 」
 * - 空的列表项再按回车：子项退一级，顶层项清掉标记（结束列表）；空引用行同理清掉
 * - 光标在标记前面、或选中了文字：不管，交给浏览器
 */
export function continueList(state: TextState): Edit | null {
  const { value, start, end } = state;
  if (start !== end) return null;
  const lineStart = lineStartAt(value, start);
  const lineEnd = lineEndAt(value, start);
  const line = value.slice(lineStart, lineEnd);
  const fenced = insideFence(value, lineStart);

  const m = fenced ? null : LIST_RE.exec(line);
  if (m) {
    const markerEnd = lineStart + m[0].length;
    if (start < markerEnd) return null;
    const rest = line.slice(m[0].length);
    if (rest.trim() === "") {
      if (m[1].length > 0) return indent(state, true);
      return { from: lineStart, to: lineEnd, insert: "", selStart: lineStart, selEnd: lineStart };
    }
    const marker = m[3] ? `${Number(m[3]) + 1}${m[4]}` : m[2];
    const task = m[6] ? "[ ] " : "";
    const insert = `\n${m[1]}${marker}${m[5]}${task}`;
    return { from: start, to: start, insert, selStart: start + insert.length, selEnd: start + insert.length };
  }

  const q = fenced ? null : QUOTE_RE.exec(line);
  if (q) {
    const prefixEnd = lineStart + q[1].length;
    if (start < prefixEnd) return null;
    if (line.slice(q[1].length).trim() === "") {
      return { from: lineStart, to: lineEnd, insert: "", selStart: lineStart, selEnd: lineStart };
    }
    const prefix = q[1].endsWith(" ") ? q[1] : `${q[1]} `;
    const insert = `\n${prefix}`;
    return { from: start, to: start, insert, selStart: start + insert.length, selEnd: start + insert.length };
  }
  const ws = /^[ \t]*/.exec(line)?.[0] ?? "";
  if (ws && start >= lineStart + ws.length) {
    const insert = `\n${ws}`;
    return { from: start, to: start, insert, selStart: start + insert.length, selEnd: start + insert.length };
  }
  return null;
}

/** 选区两头的空白挪到外面（Windows 双击选词会带上后面的空格，**词 ** 不会变粗） */
function trimSelection(value: string, start: number, end: number): [number, number] {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(value[s])) s += 1;
  while (e > s && /\s/.test(value[e - 1])) e -= 1;
  return [s, e];
}

/** 被 mark 包着：italic 的 * 不能把 **粗体** 的一半当成自己 */
function wrappedBy(value: string, start: number, end: number, mark: string): boolean {
  const n = mark.length;
  if (start < n || value.slice(start - n, start) !== mark || value.slice(end, end + n) !== mark) return false;
  if (mark === "*") {
    const boldAround = value[start - 2] === "*" && value[end + 1] === "*";
    const boldItalic = value[start - 3] === "*" && value[end + 2] === "*";
    return !boldAround || boldItalic;
  }
  return true;
}

/** Ctrl+B（**）/ Ctrl+I（*）：加上或去掉；没选中时插一对标记，光标停在中间 */
export function toggleWrap(state: TextState, mark: string): Edit {
  const { value } = state;
  const n = mark.length;
  const [start, end] = state.start === state.end ? [state.start, state.end] : trimSelection(value, state.start, state.end);
  const selected = value.slice(start, end);

  if (start !== end && wrappedBy(value, start, end, mark)) {
    return { from: start - n, to: end + n, insert: selected, selStart: start - n, selEnd: end - n };
  }
  const innerWrapped =
    selected.length >= 2 * n + 1 &&
    selected.startsWith(mark) &&
    selected.endsWith(mark) &&
    (mark !== "*" || !selected.startsWith("**") || selected.startsWith("***"));
  if (innerWrapped) {
    const inner = selected.slice(n, -n);
    return { from: start, to: end, insert: inner, selStart: start, selEnd: start + inner.length };
  }
  return { from: start, to: end, insert: `${mark}${selected}${mark}`, selStart: start + n, selEnd: end + n };
}

/**
 * Ctrl+K 且选中了文字：变成链接。
 * - 选中的是网址：[](网址)，光标停在方括号里写文字
 * - 选中的是文字：[文字](url)，选中 url，直接粘贴就替换掉
 * 没选中返回 null（Ctrl+K 照旧打开搜索）
 */
export function makeLink(state: TextState): Edit | null {
  if (state.start === state.end) return null;
  const [start, end] = trimSelection(state.value, state.start, state.end);
  if (start === end) return null;
  const selected = state.value.slice(start, end);
  if (/^(https?:\/\/|www\.)\S+$/i.test(selected)) {
    const insert = `[](${selected})`;
    return { from: start, to: end, insert, selStart: start + 1, selEnd: start + 1 };
  }
  const insert = `[${selected}](url)`;
  const urlAt = start + selected.length + 3;
  return { from: start, to: end, insert, selStart: urlAt, selEnd: urlAt + 3 };
}

/**
 * 选中文字后粘贴网址：变成 [文字](网址)（editor-007）。
 * 没选中、选中的跨行或本身就是网址、粘贴的不是单个网址：返回 null，照常粘贴。
 */
export function pasteLink(state: TextState, pasted: string): Edit | null {
  const url = pasted.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return null;
  if (state.start === state.end) return null;
  const [start, end] = trimSelection(state.value, state.start, state.end);
  const selected = state.value.slice(start, end);
  if (!selected || selected.includes("\n") || /^(https?:\/\/|www\.)\S+$/i.test(selected)) return null;
  const insert = `[${selected}](${url})`;
  return { from: start, to: end, insert, selStart: start + insert.length, selEnd: start + insert.length };
}

/** 应用一次替换后的完整文本（测试用，也方便组件做兜底） */
export function applyEditToText(value: string, edit: Edit): string {
  return value.slice(0, edit.from) + edit.insert + value.slice(edit.to);
}
