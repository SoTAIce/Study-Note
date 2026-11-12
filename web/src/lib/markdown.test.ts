import assert from "node:assert/strict";
import test from "node:test";
import { renderInline, renderMarkdown } from "./markdown.ts";

test("renderMarkdown: [[笔记]] 渲染成 wikilink 链接", () => {
  const html = renderMarkdown("看 [[位置编码]] 那篇");
  assert.match(html, /<a class="wikilink" data-target="位置编码">位置编码<\/a>/);
});

test("renderMarkdown: [[笔记|别名]] 用别名作为显示文本", () => {
  const html = renderMarkdown("参考 [[位置编码|位置编码的直觉]]");
  assert.match(html, /<a class="wikilink" data-target="位置编码">位置编码的直觉<\/a>/);
});

test("renderMarkdown: [[笔记#小节]] 保留小节显示，data-target 只含笔记名", () => {
  const html = renderMarkdown("[[位置编码#为什么需要]]");
  assert.match(html, /<a class="wikilink" data-target="位置编码">位置编码#为什么需要<\/a>/);
});

test("renderMarkdown: [[笔记#小节|别名]] 显示别名", () => {
  const html = renderMarkdown("[[位置编码#为什么需要|那一节]]");
  assert.match(html, /<a class="wikilink" data-target="位置编码">那一节<\/a>/);
});

test("renderMarkdown: ![[图片]] 原样保留，不当作双链", () => {
  const html = renderMarkdown("![[pasted-2026.png]]");
  assert.ok(html.includes("![[pasted-2026.png]]"), `实际：${html}`);
  assert.ok(!html.includes("wikilink"), `实际：${html}`);
});

test("renderMarkdown: 代码围栏里的 [[x]] 与 #tag 不被改写", () => {
  const html = renderMarkdown("```\n[[不解析]] #也不是标签\n```");
  assert.ok(html.includes("[[不解析]]"), `实际：${html}`);
  assert.ok(html.includes("#也不是标签"), `实际：${html}`);
  assert.ok(!html.includes("wikilink"), `实际：${html}`);
  assert.ok(!html.includes("tag-pill"), `实际：${html}`);
});

test("renderMarkdown: 行内代码里的 [[x]] 与 #tag 不被改写", () => {
  const html = renderMarkdown("行内 `[[不解析]]` 与 `#不是标签`");
  assert.ok(html.includes("[[不解析]]"), `实际：${html}`);
  assert.ok(html.includes("#不是标签"), `实际：${html}`);
  assert.ok(!html.includes("wikilink"), `实际：${html}`);
  assert.ok(!html.includes("tag-pill"), `实际：${html}`);
});

test("renderMarkdown: <script> 被转义，不能注入", () => {
  const html = renderMarkdown('<script>alert("x")</script>');
  assert.ok(!html.includes("<script>"), `实际：${html}`);
  assert.ok(html.includes("&lt;script&gt;"), `实际：${html}`);
});

test("renderMarkdown: #标签 渲染成 tag-pill", () => {
  const html = renderMarkdown("今天研究 #位置编码 和 #attention/机制");
  assert.match(html, /<span class="tag-pill">#位置编码<\/span>/);
  assert.match(html, /<span class="tag-pill">#attention\/机制<\/span>/);
});

test("renderMarkdown: markdown 标题里的 # 不当作标签", () => {
  const html = renderMarkdown("# 位置编码笔记");
  assert.match(html, /<h1>位置编码笔记<\/h1>/);
  assert.ok(!html.includes("tag-pill"), `实际：${html}`);
});

test("renderMarkdown: 已经渲染出的 HTML 标签不被后续替换破坏", () => {
  const html = renderMarkdown("**重点** #标签");
  assert.ok(html.includes("<strong>重点</strong>"), `实际：${html}`);
  assert.ok(html.includes('<span class="tag-pill">#标签</span>'), `实际：${html}`);
});

test("renderInline: 处理双链与标签，并转义 HTML", () => {
  const html = renderInline('<b>[[位置编码|直觉]]</b> #深度学习');
  assert.ok(html.includes("&lt;b&gt;"), `实际：${html}`);
  assert.ok(html.includes('<a class="wikilink" data-target="位置编码">直觉</a>'), `实际：${html}`);
  assert.ok(html.includes('<span class="tag-pill">#深度学习</span>'), `实际：${html}`);
  assert.ok(!html.includes("<b>"), `实际：${html}`);
});

test("双链里的 & 与引号只转义一次（点击目标要和标题一致）", () => {
  const html = renderMarkdown("[[C++ & Rust]] [[\"引号\"]]");
  assert.match(html, /data-target="C\+\+ &amp; Rust">C\+\+ &amp; Rust<\/a>/);
  assert.match(html, /data-target="&quot;引号&quot;">&quot;引号&quot;<\/a>/);
  assert.ok(!html.includes("&amp;amp;"), `实际：${html}`);
});
