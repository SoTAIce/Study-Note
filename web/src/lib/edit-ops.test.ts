import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEditToText, continueList, indent, makeLink, pasteLink, toggleWrap, type Edit, type TextState } from "./edit-ops.ts";

/** 「|」表示光标；「‹ ›」表示选区 */
function parse(text: string): TextState {
  if (text.includes("‹")) {
    const start = text.indexOf("‹");
    const end = text.indexOf("›") - 1;
    return { value: text.replace("‹", "").replace("›", ""), start, end };
  }
  const pos = text.indexOf("|");
  return { value: text.replace("|", ""), start: pos, end: pos };
}

function show(value: string, edit: Edit | null): string | null {
  if (!edit) return null;
  const next = applyEditToText(value, edit);
  if (edit.selStart === edit.selEnd) return `${next.slice(0, edit.selStart)}|${next.slice(edit.selStart)}`;
  return `${next.slice(0, edit.selStart)}‹${next.slice(edit.selStart, edit.selEnd)}›${next.slice(edit.selEnd)}`;
}

function run(op: (s: TextState) => Edit | null, text: string): string | null {
  const state = parse(text);
  return show(state.value, op(state));
}

const tab = (s: TextState) => indent(s, false);
const shiftTab = (s: TextState) => indent(s, true);

test("Tab：普通行在光标处插两个空格", () => {
  assert.equal(run(tab, "ab|cd"), "ab  |cd");
  assert.equal(run(tab, "|"), "  |");
});

test("Tab：无序列表缩到上一项的内容列，光标跟着走", () => {
  assert.equal(run(tab, "- a\n- b|"), "- a\n  - b|");
  assert.equal(run(tab, "- a\n- |b"), "- a\n  - |b");
});

test("Tab：有序列表缩 3 格（Markdown 才认得出是子项）", () => {
  assert.equal(run(tab, "1. a\n2. b|"), "1. a\n   2. b|");
  assert.equal(run(tab, "9. a\n10. b|"), "9. a\n   10. b|");
});

test("Tab：已经比上一项深的再缩两格；第一项也能缩", () => {
  assert.equal(run(tab, "- a\n  - b\n    - c|"), "- a\n  - b\n      - c|");
  assert.equal(run(tab, "- a|"), "  - a|");
});

test("Tab：选中多行整体缩进，空行不加空格，选区保持", () => {
  assert.equal(run(tab, "‹x\n\ny›"), "‹  x\n\n  y›");
  assert.equal(run(tab, "a\n‹b\nc\n›d"), "a\n‹  b\n  c\n›d");
});

test("Shift+Tab：子项退回父项缩进", () => {
  assert.equal(run(shiftTab, "1. a\n   - b|"), "1. a\n- b|");
  assert.equal(run(shiftTab, "- a\n  - b\n    - c|"), "- a\n  - b\n  - c|");
});

test("Shift+Tab：普通行退两格；顶格不动；光标不跑到行外", () => {
  assert.equal(run(shiftTab, "    co|de"), "  co|de");
  assert.equal(run(shiftTab, " |x"), "|x");
  assert.equal(run(shiftTab, "x|"), null);
  assert.equal(run(shiftTab, "‹  a\n    b›"), "‹a\n  b›");
});

test("回车：续上无序、有序、任务列表", () => {
  assert.equal(run(continueList, "- 苹果|"), "- 苹果\n- |");
  assert.equal(run(continueList, "* a|"), "* a\n* |");
  assert.equal(run(continueList, "1. a|"), "1. a\n2. |");
  assert.equal(run(continueList, "9) a|"), "9) a\n10) |");
  assert.equal(run(continueList, "  - a|"), "  - a\n  - |");
  assert.equal(run(continueList, "- [x] 做完了|"), "- [x] 做完了\n- [ ] |");
});

test("回车：在列表项中间断开，后半段带到新项", () => {
  assert.equal(run(continueList, "- 前|后"), "- 前\n- |后");
});

test("回车：空的顶层项清掉标记；空的子项退一级", () => {
  assert.equal(run(continueList, "- a\n- |"), "- a\n|");
  assert.equal(run(continueList, "1. a\n2. |"), "1. a\n|");
  assert.equal(run(continueList, "- a\n  - |"), "- a\n- |");
});

test("回车：引用续上 >，空引用行结束", () => {
  assert.equal(run(continueList, "> 一句话|"), "> 一句话\n> |");
  assert.equal(run(continueList, "> > 嵌套|"), "> > 嵌套\n> > |");
  assert.equal(run(continueList, "> a\n> |"), "> a\n|");
});

test("回车：普通行、分隔线、光标在标记前、选中文字时不管", () => {
  assert.equal(run(continueList, "普通|"), null);
  assert.equal(run(continueList, "---|"), null);
  assert.equal(run(continueList, "-| a"), null);
  assert.equal(run(continueList, "- ‹a›"), null);
});

test("Ctrl+B：加粗、再按去掉；没选中插一对", () => {
  const bold = (s: TextState) => toggleWrap(s, "**");
  assert.equal(run(bold, "a ‹词› b"), "a **‹词›** b");
  assert.equal(run(bold, "a **‹词›** b"), "a ‹词› b");
  assert.equal(run(bold, "a ‹**词**› b"), "a ‹词› b");
  assert.equal(run(bold, "a|"), "a**|**");
});

test("Ctrl+B：选区两头的空格挪到外面（Windows 双击选词带空格）", () => {
  assert.equal(run((s) => toggleWrap(s, "**"), "‹word ›next"), "**‹word›** next");
});

test("Ctrl+I：斜体；不会把粗体的一半当成斜体", () => {
  const italic = (s: TextState) => toggleWrap(s, "*");
  assert.equal(run(italic, "‹词›"), "*‹词›*");
  assert.equal(run(italic, "*‹词›*"), "‹词›");
  assert.equal(run(italic, "**‹词›**"), "***‹词›***");
  assert.equal(run(italic, "***‹词›***"), "**‹词›**");
  assert.equal(run(italic, "‹**词**›"), "*‹**词**›*");
});

test("Ctrl+K：文字变链接并选中 url；网址变 [](网址)；没选中返回 null", () => {
  assert.equal(run(makeLink, "看‹这篇›文章"), "看[这篇](‹url›)文章");
  assert.equal(run(makeLink, "‹https://example.com/a›"), "[|](https://example.com/a)");
  assert.equal(run(makeLink, "a|b"), null);
  assert.equal(run(makeLink, "‹  ›"), null);
});

test("回车：有缩进的普通行保持缩进；光标在缩进里不管", () => {
  assert.equal(run(continueList, "    const a = 1;|"), "    const a = 1;\n    |");
  assert.equal(run(continueList, "\tx|"), "\tx\n\t|");
  assert.equal(run(continueList, "  |x"), "  \n  |x");
  assert.equal(run(continueList, " | x"), null);
});

test("回车：代码块里只保持缩进，不续列表 / 引用标记", () => {
  assert.equal(run(continueList, "```\n- 不是列表|"), null);
  assert.equal(run(continueList, "```\n  - x|"), "```\n  - x\n  |");
  assert.equal(run(continueList, "```\na\n```\n- 是列表|"), "```\na\n```\n- 是列表\n- |");
});

test("粘贴网址：选中文字变链接；其他情况照常粘贴", () => {
  assert.equal(run((s) => pasteLink(s, "https://example.com/a"), "看‹这篇›"), "看[这篇](https://example.com/a)|");
  assert.equal(run((s) => pasteLink(s, " https://x.io \n"), "‹词 ›"), "[词](https://x.io)| ");
  assert.equal(run((s) => pasteLink(s, "https://x.io"), "a|b"), null);
  assert.equal(run((s) => pasteLink(s, "不是网址"), "‹词›"), null);
  assert.equal(run((s) => pasteLink(s, "https://a.io https://b.io"), "‹词›"), null);
  assert.equal(run((s) => pasteLink(s, "https://x.io"), "‹a\nb›"), null);
  assert.equal(run((s) => pasteLink(s, "https://x.io"), "‹https://old.io›"), null);
});
