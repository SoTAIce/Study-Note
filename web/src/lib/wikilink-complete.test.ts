import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEditToText } from "./edit-ops.ts";
import { completeWikilink, rankTitles, wikilinkQuery } from "./wikilink-complete.ts";

function q(text: string) {
  const caret = text.indexOf("¦");
  return wikilinkQuery(text.replace("¦", ""), caret);
}

test("wikilinkQuery：认出没写完的 [[", () => {
  assert.deepEqual(q("参见 [[¦"), { start: 3, query: "" });
  assert.deepEqual(q("参见 [[梯度¦"), { start: 3, query: "梯度" });
  assert.deepEqual(q("[[a]] 和 [[b¦"), { start: 8, query: "b" });
  assert.deepEqual(q("[[梯度¦]]"), { start: 0, query: "梯度" });
  assert.deepEqual(q("[[[¦"), { start: 1, query: "" });
});

test("wikilinkQuery：已写完、换行、别名、单个 [ 都不提示", () => {
  assert.equal(q("[[a]] ¦"), null);
  assert.equal(q("[[a\nb¦"), null);
  assert.equal(q("[[标题|别¦"), null);
  assert.equal(q("[x¦"), null);
  assert.equal(q("¦[["), null);
  assert.equal(q(`[[${"字".repeat(61)}¦`), null);
});

test("rankTitles：整题 > 开头 > 包含，短的在前；不提示当前这篇", () => {
  const titles = ["梯度下降与学习率", "随机梯度下降", "梯度", "注意力机制", "梯度下降"];
  assert.deepEqual(rankTitles(titles, "梯度", null), ["梯度", "梯度下降", "梯度下降与学习率", "随机梯度下降"]);
  assert.deepEqual(rankTitles(titles, "梯度", "梯度"), ["梯度下降", "梯度下降与学习率", "随机梯度下降"]);
  assert.deepEqual(rankTitles(["Attention", "attention map"], "ATT", null), ["Attention", "attention map"]);
  assert.deepEqual(rankTitles(titles, "没有", null), []);
});

test("rankTitles：没打字按传入顺序（最近更新）列前几篇，去重、限量", () => {
  assert.deepEqual(rankTitles(["c", "a", "c", "", "b"], "", null, 2), ["c", "a"]);
});

test("completeWikilink：补成 [[标题]]，光标在后面；已有 ]] 不重复", () => {
  const v1 = "参见 [[梯度";
  const e1 = completeWikilink(v1, { start: 3, query: "梯度" }, v1.length, "梯度下降");
  assert.equal(applyEditToText(v1, e1), "参见 [[梯度下降]]");
  assert.equal(e1.selStart, "参见 [[梯度下降]]".length);
  const v2 = "参见 [[梯]] 后文";
  const e2 = completeWikilink(v2, { start: 3, query: "梯" }, 6, "梯度");
  assert.equal(applyEditToText(v2, e2), "参见 [[梯度]] 后文");
});
