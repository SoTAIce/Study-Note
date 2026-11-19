import assert from "node:assert/strict";
import test from "node:test";
import {
  activeOutlineIndex,
  buildOutline,
  neighbors,
  parsePositions,
  parseWidth,
  readingLayout,
  rememberPosition,
  scrollRatio,
} from "./reading.ts";

test("目录：只取 h1–h3，缩进从最浅那级算，空标题跳过，下标对应原数组", () => {
  const outline = buildOutline([
    { level: 2, text: "一、概念" },
    { level: 4, text: "细节" },
    { level: 3, text: "  链式  法则 " },
    { level: 2, text: "" },
    { level: 2, text: "二、例子" },
  ]);
  assert.deepEqual(outline, [
    { index: 0, depth: 0, text: "一、概念" },
    { index: 2, depth: 1, text: "链式 法则" },
    { index: 4, depth: 0, text: "二、例子" },
  ]);
  assert.deepEqual(buildOutline([{ level: 5, text: "x" }]), []);
});

test("当前小节：最后一个滚过阅读线的标题；还没到第一个标题时算第一个", () => {
  const tops = [0, 500, 1200];
  assert.equal(activeOutlineIndex(tops, 0), 0);
  assert.equal(activeOutlineIndex(tops, 403), 0);
  assert.equal(activeOutlineIndex(tops, 404), 1);
  assert.equal(activeOutlineIndex(tops, 5000), 2);
  assert.equal(activeOutlineIndex([300], 0), 0);
  assert.equal(activeOutlineIndex([], 100), -1);
});

test("上一篇 / 下一篇按列表顺序，两端和不在列表里时没有", () => {
  const ids = ["a", "b", "c"];
  assert.deepEqual(neighbors(ids, "b"), { prev: "a", next: "c" });
  assert.deepEqual(neighbors(ids, "a"), { prev: null, next: "b" });
  assert.deepEqual(neighbors(ids, "c"), { prev: "b", next: null });
  assert.deepEqual(neighbors(ids, "x"), { prev: null, next: null });
  assert.deepEqual(neighbors(ids, null), { prev: null, next: null });
});

test("阅读比例：0–1，内容不够一屏时为 0", () => {
  assert.equal(scrollRatio(0, 2000, 1000), 0);
  assert.equal(scrollRatio(500, 2000, 1000), 0.5);
  assert.equal(scrollRatio(1200, 2000, 1000), 1);
  assert.equal(scrollRatio(10, 800, 1000), 0);
});

test("阅读位置：坏数据当没有；最近读的在最后；超上限丢最早的；开头和读完不记", () => {
  assert.deepEqual(parsePositions(null), {});
  assert.deepEqual(parsePositions("not json"), {});
  assert.deepEqual(parsePositions("[1]"), {});
  assert.deepEqual(parsePositions('{"a":0.5,"b":"x","c":7}'), { a: 0.5, c: 1 });

  let map = rememberPosition({}, "a", 0.25);
  map = rememberPosition(map, "b", 0.5);
  map = rememberPosition(map, "a", 0.3333);
  assert.deepEqual(Object.keys(map), ["b", "a"]);
  assert.equal(map.a, 0.333);
  assert.deepEqual(Object.keys(rememberPosition(map, "c", 0.5, 2)), ["a", "c"]);
  assert.equal(rememberPosition(map, "a", 0).a, undefined);
  assert.equal(rememberPosition(map, "a", 1).a, undefined);
});

test("行宽设置：未知值回到「中」", () => {
  assert.equal(parseWidth("narrow"), "narrow");
  assert.equal(parseWidth("wide"), "wide");
  // 默认改成「自动」（read-003）；不认识的值也回到自动
  assert.equal(parseWidth(null), "auto");
  assert.equal(parseWidth("huge"), "auto");
  assert.equal(parseWidth("medium"), "medium");
  assert.equal(parseWidth("full"), "full");
  assert.equal(parseWidth("auto"), "auto");
});

test("readingLayout：固定档不变；满宽不限宽；自动档随正文区变宽、宽屏字号最多放大 1.25 倍（read-003）", () => {
  assert.deepEqual(readingLayout("wide", 1680, 18), { fontSize: 18, maxWidth: 840 });
  assert.deepEqual(readingLayout("narrow", 400, 18), { fontSize: 18, maxWidth: 600 });
  assert.deepEqual(readingLayout("full", 1680, 18), { fontSize: 18, maxWidth: null });
  // 笔记本（正文区 900）：字号不变，版心 = 正文区减两边留白
  assert.deepEqual(readingLayout("auto", 900, 18), { fontSize: 18, maxWidth: 844 });
  // 1920 全屏（正文区约 1680）：字号放大到 23（×1.25 封顶），一行约 48 字
  const wide = readingLayout("auto", 1680, 18);
  assert.equal(wide.fontSize, 23);
  assert.equal(wide.maxWidth, 23 * 48);
  assert.ok((wide.maxWidth ?? 0) > 840, "宽屏下要比原来最宽的 840 宽");
  // 极宽（4K）：字号封顶，不会无限变大
  assert.equal(readingLayout("auto", 3600, 18).fontSize, 23);
  // 很窄的窗口：不小于 320
  assert.equal(readingLayout("auto", 300, 18).maxWidth, 320);
});
