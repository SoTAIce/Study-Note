import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultImportGroup,
  hasImageItem,
  isFileDrag,
  pickMarkdown,
  previewLines,
  previewMarkdown,
  referencesLocalImages,
} from "./md-import.ts";

const file = (name: string, type = "") => ({ name, type, size: 1 });

test("挑文件：只认第一个 .md，其它 .md 算跳过；一个 .md 都没有时提示", () => {
  assert.deepEqual(pickMarkdown([file("a.md"), file("b.MD"), file("c.png", "image/png")]), { md: file("a.md"), skipped: 1, rejected: null });
  assert.deepEqual(pickMarkdown([file("x.txt"), file("y.markdown")]), { md: file("y.markdown"), skipped: 0, rejected: null });
  assert.deepEqual(pickMarkdown([file("x.txt")]), { md: null, skipped: 0, rejected: "只能导入 .md 文件" });
  assert.deepEqual(pickMarkdown([]), { md: null, skipped: 0, rejected: null });
});

test("拖动的是不是文件、有没有图片", () => {
  assert.equal(isFileDrag(["Files"]), true);
  assert.equal(isFileDrag(["text/plain"]), false);
  assert.equal(hasImageItem([{ kind: "file", type: "image/png" }]), true);
  assert.equal(hasImageItem([{ kind: "file", type: "text/markdown" }, { kind: "string", type: "image/png" }]), false);
});

test("预选分组：拖到的项目 → 正在连读的项目 → 左栏选中的分组 → 不分组", () => {
  const all = { kind: "all" } as const;
  assert.equal(defaultImportGroup({ dropGroup: "甲/乙", bookGroup: "丙", filter: { kind: "group", name: "丁" } }), "甲/乙");
  assert.equal(defaultImportGroup({ dropGroup: null, bookGroup: "丙", filter: { kind: "group", name: "丁" } }), "丙");
  assert.equal(defaultImportGroup({ dropGroup: null, bookGroup: null, filter: { kind: "group", name: "丁" } }), "丁");
  assert.equal(defaultImportGroup({ dropGroup: null, bookGroup: null, filter: all }), null);
  assert.equal(defaultImportGroup({ dropGroup: null, bookGroup: null, filter: { kind: "tag", tag: "x" } }), null);
});

test("预览：标题来源、正文、保留下来的键（应用自己管的不算）", () => {
  const head = previewMarkdown("x.md", "---\nid: abc\ntitle: \"头里的\"\naliases:\n  - 别名\ntags:\n  - 读书\ncssclass: wide\n---\n\n# 正文标题\n\n内容\n");
  assert.equal(head.title, "头里的");
  assert.equal(head.body, "# 正文标题\n\n内容\n");
  assert.deepEqual(head.keptKeys, ["aliases", "tags", "cssclass"]);
  assert.equal(previewMarkdown("x.md", "前言\n\n# 正文标题\n").title, "正文标题");
  assert.equal(previewMarkdown("2026-01-02-学习_记录.md", "正文").title, "学习 记录");
  // 不像文件头的 --- 分隔线：整段算正文
  const rule = previewMarkdown("a.md", "---\n这不是文件头\n---\n正文");
  assert.equal(rule.body, "---\n这不是文件头\n---\n正文");
  assert.deepEqual(rule.keptKeys, []);
  // CRLF 和 BOM
  assert.equal(previewMarkdown("a.md", "﻿---\r\ntitle: 视窗\r\n---\r\n正文\r\n").title, "视窗");
});

test("本地图片引用：相对路径和 ![[图]] 算；网络图片和 data: 不算", () => {
  assert.equal(referencesLocalImages("![](img/a.png)"), true);
  assert.equal(referencesLocalImages("![图](<../x y.png>)"), true);
  assert.equal(referencesLocalImages("![[截图.png]]"), true);
  assert.equal(referencesLocalImages("![](https://example.com/a.png) ![](data:image/png;base64,xx)"), false);
  assert.equal(referencesLocalImages("[链接](a.md)"), false);
});

test("预览开头几行：多了加省略号", () => {
  assert.equal(previewLines("a\nb\nc", 2), "a\nb\n…");
  assert.equal(previewLines("a\nb", 5), "a\nb");
});
