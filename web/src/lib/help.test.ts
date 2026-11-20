import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHEAT_GROUPS,
  CHEAT_SHEET,
  MANUAL_TITLE_PREFIX,
  chapterForLink,
  filterCheatSheet,
  groupChapters,
  isHelpKey,
} from "./help.ts";
import { ACTIONS, resolveKey } from "./keyboard.ts";

test("速查表和 keyboard.ts 一致：每个应用级动作都列了，列的按键组合确实触发这个动作", () => {
  for (const action of ACTIONS) {
    const rows = CHEAT_SHEET.filter((row) => row.action === action);
    assert.ok(rows.length > 0, `速查表里缺「${action}」`);
    for (const row of rows) {
      assert.ok(row.combo, `「${row.keys}」标了动作但没写按键组合`);
      assert.equal(resolveKey(row.combo), action, `「${row.keys}」实际触发的是 ${resolveKey(row.combo)}`);
    }
  }
  // 带 combo 的行都要标动作，免得写了按键却没核对
  for (const row of CHEAT_SHEET) if (row.combo) assert.ok(row.action, `「${row.keys}」有按键组合但没标动作`);
});

test("速查表每行都有分组、按键、作用；分组都在显示顺序里", () => {
  for (const row of CHEAT_SHEET) {
    assert.ok(CHEAT_GROUPS.includes(row.group), row.keys);
    assert.ok(row.keys.trim() && row.does.trim(), JSON.stringify(row));
  }
  for (const group of CHEAT_GROUPS) assert.ok(CHEAT_SHEET.some((row) => row.group === group), `分组「${group}」是空的`);
});

test("筛选：按键、作用、补充、分组都能搜；几个词都要有；不区分大小写；空的返回全部", () => {
  assert.equal(filterCheatSheet(CHEAT_SHEET, "  ").length, CHEAT_SHEET.length);
  const review = filterCheatSheet(CHEAT_SHEET, "复习");
  assert.ok(review.length >= 4 && review.every((row) => `${row.group}${row.does}${row.note ?? ""}`.includes("复习")));
  assert.deepEqual(filterCheatSheet(CHEAT_SHEET, "ctrl+k 搜索").map((row) => row.keys), ["Ctrl+K"]);
  assert.ok(filterCheatSheet(CHEAT_SHEET, "::").some((row) => row.keys === "概念 :: 解释"));
  assert.deepEqual(filterCheatSheet(CHEAT_SHEET, "没有这种东西"), []);
});

test("? 键：单独的 ? 才算；在输入框里、带 Ctrl / ⌘ / Alt 不算", () => {
  assert.equal(isHelpKey({ key: "?" }, false), true);
  assert.equal(isHelpKey({ key: "?" }, true), false);
  assert.equal(isHelpKey({ key: "?", ctrlKey: true }, false), false);
  assert.equal(isHelpKey({ key: "?", metaKey: true }, false), false);
  assert.equal(isHelpKey({ key: "?", altKey: true }, false), false);
  assert.equal(isHelpKey({ key: "/" }, false), false);
});

test("手册章节：按部分分组保持顺序；只认带「手册：」前缀的双链", () => {
  const chapters = [
    { slug: "a", title: `${MANUAL_TITLE_PREFIX}甲`, part: "一", body: "" },
    { slug: "b", title: `${MANUAL_TITLE_PREFIX}乙`, part: "一", body: "" },
    { slug: "c", title: `${MANUAL_TITLE_PREFIX}丙`, part: "二", body: "" },
  ];
  assert.deepEqual(
    groupChapters(chapters).map((part) => [part.part, part.chapters.map((chapter) => chapter.slug)]),
    [
      ["一", ["a", "b"]],
      ["二", ["c"]],
    ],
  );
  assert.equal(chapterForLink(chapters, ` ${MANUAL_TITLE_PREFIX}乙 `)?.slug, "b");
  assert.equal(chapterForLink(chapters, "乙"), undefined);
  assert.equal(chapterForLink(chapters, `${MANUAL_TITLE_PREFIX}没有`), undefined);
});
