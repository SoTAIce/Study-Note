import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBookToc, findChapter, stepChapter, stripLeadingTitle } from "./book.ts";

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
