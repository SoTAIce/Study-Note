import { test } from "node:test";
import assert from "node:assert/strict";
import { isMarkdownFileName, normalizeImported, prepareImport, previewImport } from "../import-md.ts";

const NOW = "2026-11-20T10:00:00+08:00";
const base = { fileName: "读书笔记.md", group: null, now: NOW, idTaken: () => false, newId: () => "newid001" };

test("标题依次取：文件头 title → 第一个 # 标题 → 文件名；框里填了就用框里的", () => {
  assert.equal(previewImport("x.md", "---\ntitle: 头里的\n---\n\n# 正文标题\n").title, "头里的");
  assert.equal(previewImport("x.md", "前言\n\n# 正文标题\n\n内容").title, "正文标题");
  assert.equal(previewImport("2026-01-02-学习-记录.md", "没有标题的正文").title, "学习 记录");
  assert.equal(previewImport("notes.markdown", "正文").title, "notes");
  const { meta } = prepareImport({ ...base, content: "# 正文标题\n", title: "  框里改的  " });
  assert.equal(meta.title, "框里改的");
});

test("Obsidian 的文件头：未知键、块状 tags、顺序原样保留；缺的补上；正文一个字不改", () => {
  const content = "---\ntitle: 黑曜石\naliases:\n  - 别名\ntags:\n  - 读书\n  - 复习\ncssclass: wide\n---\n\n# 黑曜石\n\n正文 #行内标签\n";
  const { meta, text } = prepareImport({ ...base, content, group: "读书/文学" });
  assert.equal(meta.id, "newid001");
  assert.deepEqual(meta.tags, ["读书", "复习"]);
  assert.equal(meta.group, "读书/文学");
  assert.equal(meta.created, NOW, "没写 created 就用导入时间");
  assert.equal(meta.updated, NOW);
  assert.equal(meta.type, "note");
  for (const part of ["title: 黑曜石", "aliases:\n  - 别名", "tags:\n  - 读书\n  - 复习", "cssclass: wide", "group: 读书/文学", "id: newid001"]) {
    assert.ok(text.includes(part), `应有「${part}」：\n${text}`);
  }
  assert.ok(text.indexOf("aliases:") < text.indexOf("cssclass:"), "原有键的顺序不变");
  assert.ok(text.endsWith("---\n\n# 黑曜石\n\n正文 #行内标签\n"), `正文应原样：\n${text}`);
});

test("id：合法且没被占用就留着；被占用、空白、太长都换新的", () => {
  const withId = (id: string) => `---\nid: ${id}\ntitle: t\n---\n正文\n`;
  assert.equal(prepareImport({ ...base, content: withId("keep1234") }).meta.id, "keep1234");
  assert.equal(prepareImport({ ...base, content: withId("taken000"), idTaken: (id) => id === "taken000" }).meta.id, "newid001");
  assert.equal(prepareImport({ ...base, content: withId('"has space"') }).meta.id, "newid001");
  assert.equal(prepareImport({ ...base, content: withId("x".repeat(65)) }).meta.id, "newid001");
  const { text } = prepareImport({ ...base, content: withId("taken000"), idTaken: () => true });
  assert.ok(text.startsWith("---\nid: newid001\n"), text);
});

test("created 合法就保留，不合法换成导入时间；type 不认识当 note；group 选了覆盖、不分组时去掉", () => {
  const ok = prepareImport({ ...base, content: "---\ncreated: 2024-03-05T08:00:00+08:00\ntype: source\ngroup: 旧组\n---\n正文\n" });
  assert.equal(ok.meta.created, "2024-03-05T08:00:00+08:00");
  assert.equal(ok.meta.type, "source");
  assert.equal(ok.meta.group, undefined);
  assert.equal(ok.text.includes("group:"), false, "不分组时去掉 group 行");
  const bad = prepareImport({ ...base, content: "---\ncreated: 去年\ntype: 随笔\n---\n正文\n", group: "新组" });
  assert.equal(bad.meta.created, NOW);
  assert.equal(bad.meta.type, "note");
  assert.ok(bad.text.includes("group: 新组"));
  assert.ok(bad.text.includes(`created: ${NOW}`));
});

test("模板名、source 保留", () => {
  const { meta, text } = prepareImport({ ...base, content: "---\ntemplate: 实现详情\nsource: https://example.com\n---\n正文\n" });
  assert.equal(meta.template, "实现详情");
  assert.equal(meta.source, "https://example.com");
  assert.ok(text.includes("template: 实现详情") && text.includes("source: https://example.com"));
});

test("没有文件头：生成一个；坏的文件头（没闭合）整段当正文", () => {
  const plain = prepareImport({ ...base, content: "# 标题\n\n正文\n" });
  assert.ok(plain.text.startsWith("---\nid: newid001\ntitle: 标题\n"));
  assert.ok(plain.text.endsWith("# 标题\n\n正文\n"));
  const broken = "---\ntitle: 没闭合\n\n# 真标题\n\n正文\n";
  const result = prepareImport({ ...base, content: broken });
  assert.equal(result.meta.title, "真标题");
  assert.ok(result.text.endsWith(broken), "坏文件头原样留在正文里");
});

test("BOM、CRLF：统一成 LF、去掉 BOM", () => {
  assert.equal(normalizeImported("﻿a\r\nb\rc\n"), "a\nb\nc\n");
  const { text } = prepareImport({ ...base, content: "﻿---\r\ntitle: 视窗\r\nfoo: bar\r\n---\r\n\r\n正文\r\n" });
  assert.equal(text.includes("\r"), false);
  assert.equal(text.startsWith("﻿"), false);
  assert.ok(text.includes("foo: bar"));
  assert.ok(text.endsWith("---\n\n正文\n"));
});

test("扩展名：.md / .markdown 才算", () => {
  assert.equal(isMarkdownFileName("a.md"), true);
  assert.equal(isMarkdownFileName("A.MD"), true);
  assert.equal(isMarkdownFileName("a.markdown"), true);
  assert.equal(isMarkdownFileName("a.txt"), false);
  assert.equal(isMarkdownFileName("md"), false);
});
