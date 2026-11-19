import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBookToc, caretForLine, findChapter, stepChapter, stripLeadingTitle, syncEditing } from "./book.ts";

test("stripLeadingTitle 只去掉和章节标题相同的开头 # 标题", () => {
  assert.equal(stripLeadingTitle("# 实现\n\n正文\n", "实现"), "正文\n");
  assert.equal(stripLeadingTitle("\n# 实现 #\r\n正文", "实现"), "正文");
  assert.equal(stripLeadingTitle("# 别的\n正文", "实现"), "# 别的\n正文");
  assert.equal(stripLeadingTitle("## 实现\n正文", "实现"), "## 实现\n正文");
  assert.equal(stripLeadingTitle("正文 # 实现", "实现"), "正文 # 实现");
});

test("buildBookToc：章为 0 级，# / ## 为 1 级，### 为 2 级，更深的和空的不要", () => {
  const toc = buildBookToc([
    { kind: "chapter", level: 0, text: "looprun" },
    { kind: "heading", level: 2, text: " 主循环 " },
    { kind: "heading", level: 3, text: "重试" },
    { kind: "heading", level: 4, text: "细节" },
    { kind: "heading", level: 2, text: "  " },
    { kind: "chapter", level: 0, text: "trace" },
  ]);
  assert.deepEqual(toc, [
    { index: 0, depth: 0, text: "looprun" },
    { index: 1, depth: 1, text: "主循环" },
    { index: 2, depth: 2, text: "重试" },
    { index: 5, depth: 0, text: "trace" },
  ]);
});

test("findChapter 先精确后不区分大小写，缺章（null）跳过", () => {
  assert.equal(findChapter(["A", null, "Looprun"], "Looprun"), 2);
  assert.equal(findChapter(["A", null, "Looprun"], "looprun"), 2);
  assert.equal(findChapter(["A"], "B"), -1);
});

test("stepChapter：按当前所在章跳上一章 / 下一章，到头返回 -1", () => {
  const tops = [0, 500, 1000];
  assert.equal(stepChapter(tops, 0, 1), 1);
  assert.equal(stepChapter(tops, 600, 1), 2);
  assert.equal(stepChapter(tops, 600, -1), 0);
  assert.equal(stepChapter(tops, 1200, 1), -1);
  assert.equal(stepChapter([200, 500], 0, -1), -1);
  assert.equal(stepChapter([200, 500], 0, 1), 0);
  assert.equal(stepChapter([], 0, 1), -1);
});

test("caretForLine：预览块的行号换算回整篇正文里的位置", () => {
  const body = "# 实现\n\n第一段\n\n## 小节\n第二段\n";
  const shown = stripLeadingTitle(body, "实现");
  assert.equal(shown, "第一段\n\n## 小节\n第二段\n");
  assert.equal(body.slice(caretForLine(body, shown, 0)), shown);
  assert.equal(body.slice(caretForLine(body, shown, 2)), "## 小节\n第二段\n");
  assert.equal(caretForLine(body, shown, 99), body.length);
  assert.equal(caretForLine(body, shown, null), body.length);
  assert.equal(caretForLine(body, body, 1), body.indexOf("\n") + 1);
});

test("syncEditing：自己存的 / 编辑起点不动；别处改了且没动过就换新；两边都改了是冲突", () => {
  const editing = { baseHash: "h1", draft: "a", original: "a" };
  assert.equal(syncEditing(editing, { hash: "h1" }, new Set()), "keep");
  assert.equal(syncEditing(editing, { hash: "h2" }, new Set(["h2"])), "keep");
  assert.equal(syncEditing(editing, { hash: "h3" }, new Set()), "adopt");
  assert.equal(syncEditing({ ...editing, draft: "ab" }, { hash: "h3" }, new Set()), "conflict");
});

test("syncEditing：已在冲突里，磁盘还是那个版本就不动；磁盘又变了再报冲突（带上最新 hash）", () => {
  const conflicted = { baseHash: "h1", draft: "ab", original: "a", diskHash: "h3" };
  assert.equal(syncEditing(conflicted, { hash: "h3" }, new Set()), "keep");
  assert.equal(syncEditing(conflicted, { hash: "h4" }, new Set()), "conflict");
});
