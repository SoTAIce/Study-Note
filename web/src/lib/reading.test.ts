import assert from "node:assert/strict";
import test from "node:test";
import {
  SPLIT_DEFAULT_RATIO,
  SPLIT_MAX_RATIO,
  SPLIT_MIN_RATIO,
  activeOutlineIndex,
  buildOutline,
  canSplit,
  clampSplitRatio,
  neighbors,
  nudgeSplitRatio,
  otherPane,
  paneNavigation,
  parseSplitRatio,
  ratioFromPointer,
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

test("分屏比例：夹在 30%～70%，坏数据用 50%，键盘每次调 5%，拖动按指针位置算", () => {
  assert.equal(clampSplitRatio(0.1), SPLIT_MIN_RATIO);
  assert.equal(clampSplitRatio(0.95), SPLIT_MAX_RATIO);
  assert.equal(clampSplitRatio(0.4567), 0.457);
  assert.equal(clampSplitRatio(Number.NaN), SPLIT_DEFAULT_RATIO);
  assert.equal(parseSplitRatio(null), 0.5);
  assert.equal(parseSplitRatio(""), 0.5);
  assert.equal(parseSplitRatio("abc"), 0.5);
  assert.equal(parseSplitRatio("0.62"), 0.62);
  assert.equal(parseSplitRatio("2"), 0.7);
  assert.equal(nudgeSplitRatio(0.5, 1), 0.55);
  assert.equal(nudgeSplitRatio(0.5, -1), 0.45);
  assert.equal(nudgeSplitRatio(0.68, 1), 0.7);
  assert.equal(nudgeSplitRatio(0.32, -1), 0.3);
  assert.equal(ratioFromPointer(600, 100, 1000), 0.5);
  assert.equal(ratioFromPointer(150, 100, 1000), 0.3);
  assert.equal(ratioFromPointer(1090, 100, 1000), 0.7);
  assert.equal(ratioFromPointer(500, 0, 0), 0.5);
});

test("窄窗口不能分屏：不到 900px", () => {
  assert.equal(canSplit(899), false);
  assert.equal(canSplit(900), true);
  assert.equal(canSplit(1920), true);
});

test("翻篇作用于当前栏，按中间列表顺序；没分屏时总是左栏；到头或不在列表里返回 null", () => {
  const ids = ["a", "b", "c", "d"];
  const base = { split: true, leftId: "b", rightId: "c", ids };
  assert.deepEqual(paneNavigation({ ...base, active: "left", direction: 1 }), { pane: "left", id: "c" });
  assert.deepEqual(paneNavigation({ ...base, active: "right", direction: 1 }), { pane: "right", id: "d" });
  assert.deepEqual(paneNavigation({ ...base, active: "right", direction: -1 }), { pane: "right", id: "b" });
  assert.equal(paneNavigation({ ...base, active: "right", rightId: "d", direction: 1 }), null);
  assert.equal(paneNavigation({ ...base, active: "right", rightId: "zz", direction: 1 }), null);
  // 没分屏：即使记着「右栏」也只翻左栏
  assert.deepEqual(paneNavigation({ ...base, split: false, active: "right", direction: -1 }), { pane: "left", id: "a" });
  assert.deepEqual(paneNavigation({ ...base, active: "right", rightId: null, direction: 1 }), { pane: "left", id: "c" });
  assert.equal(otherPane("left"), "right");
  assert.equal(otherPane("right"), "left");
});
