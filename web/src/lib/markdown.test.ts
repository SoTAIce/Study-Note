import assert from "node:assert/strict";
import test from "node:test";
import { renderInline, renderMarkdown, toggleTask } from "./markdown.ts";

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

test("任务框：默认禁用；interactiveTasks 时可点", () => {
  const md = "- [ ] 未完成\n- [x] 完成";
  const html = renderMarkdown(md);
  assert.equal((html.match(/class="task-check"/g) ?? []).length, 2);
  assert.equal((html.match(/ disabled>/g) ?? []).length, 2);
  const live = renderMarkdown(md, { interactiveTasks: true });
  assert.equal((live.match(/ disabled>/g) ?? []).length, 0);
  assert.equal((live.match(/ checked>/g) ?? []).length, 1);
});

test("任务框：笔记里手写的 input 标签不会被当成任务框放开", () => {
  const live = renderMarkdown('<input class="task-check" type="checkbox" disabled>', { interactiveTasks: true });
  assert.ok(!live.includes("<input"));
});

test("toggleTask：第 N 个框的序号和预览里一致（代码块里的不算）", () => {
  const samples = [
    "- [ ] a\n- [x] b\n- [ ] c",
    "1. [ ] 一\n2. [X] 二\n\n> - [ ] 引用里的",
    "```\n- [ ] 代码里\n```\n- [ ] 外面\n  - [x] 子项",
    "~~~md\n- [ ] x\n```\n- [ ] 还在代码里\n~~~\n* [ ] 出来了",
    "- [ ]\n- [ ] 有字\n-[ ] 不是任务\n- [ ]x 也不是",
  ];
  for (const md of samples) {
    const states = (html: string) => [...html.matchAll(/class="task-check" type="checkbox"( checked)?/g)].map((m) => Boolean(m[1]));
    const before = states(renderMarkdown(md));
    assert.ok(before.length > 0, md);
    for (let i = 0; i < before.length; i += 1) {
      const next = toggleTask(md, i);
      assert.ok(next !== null, `${md} #${i}`);
      const after = states(renderMarkdown(next));
      assert.deepEqual(after, before.map((v, k) => (k === i ? !v : v)), `${md} #${i}`);
    }
    assert.equal(toggleTask(md, before.length), null);
  }
});

test("toggleTask：只改框，不动别的文字", () => {
  assert.equal(toggleTask("- [ ] 买 [x] 牛奶", 0), "- [x] 买 [x] 牛奶");
  assert.equal(toggleTask("- [X] 好", 0), "- [ ] 好");
});

test("sourceLines：顶层块带源码行号，渲染结果其余部分不变", () => {
  const md = "# 标题\n\n第一段\n第一段续\n\n- a\n- b\n\n```\ncode\n```\n\n> 引用\n\n[链接][r]\n\n[r]: https://example.com";
  const plain = renderMarkdown(md);
  const lined = renderMarkdown(md, { sourceLines: true });
  assert.equal(lined.replace(/ data-line="\d+"/g, ""), plain);
  const lines = [...lined.matchAll(/<(\w+) data-line="(\d+)"/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(lines, ["h1:0", "p:2", "ul:5", "pre:8", "blockquote:12", "p:14"]);
});

test("sourceLines：被转义的 HTML 块包一层 div 带行号", () => {
  const lined = renderMarkdown("段落\n\n<div>x</div>\n", { sourceLines: true });
  assert.match(lined, /<div data-line="2">&lt;div&gt;/);
});
