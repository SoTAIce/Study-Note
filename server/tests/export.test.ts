import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildBookExportHtml,
  buildExportHtml,
  demoteHeadings,
  exportFileName,
  findBrowser,
  inlineImages,
  loadExportCss,
  rewriteBookLinks,
  tokenValue,
  type ExportNote,
} from "../export.ts";
import { NoteStore } from "../store.ts";

const css = loadExportCss();
const note: ExportNote = {
  title: "反向传播",
  body: "# 反向传播\n\n正文 <script>alert(1)</script> [[梯度下降]]\n\n```\nlong\n```\n",
  updated: "2026-11-14T10:00:00+08:00",
  group: "机器学习",
  tags: ["深度学习"],
};

test("导出 HTML：正文里的原始 HTML 被转义，禁止脚本，样式全部内联", () => {
  const html = buildExportHtml(note, { layout: "phone", dark: false, meta: true }, css);
  assert.ok(!html.includes("<script>alert(1)</script>"), "原始 <script> 不能原样出现");
  assert.ok(html.includes("&lt;script&gt;"), "应转义成文字");
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'none'/);
  assert.ok(!/<link\b/.test(html) && !/<script\b/.test(html), "不能引用外部样式或脚本");
  assert.ok(html.includes("--bg:"), "应内联 global.css 的 token");
  assert.ok(html.includes(".preview.reading pre"), "应内联 reading.css");
  assert.match(html, /class="wikilink"[^>]*>梯度下降</);
});

test("导出 HTML：版式决定纸张大小和字号；深色主题；元信息可关", () => {
  const phone = buildExportHtml(note, { layout: "phone", dark: false, meta: true }, css);
  assert.match(phone, /size: 100mm 178mm/);
  assert.match(phone, /font-size: 12pt/);
  assert.match(phone, /data-theme="light"/);
  assert.match(phone, /<p class="export__meta">2026-11-14 更新 · 分组 机器学习 · #深度学习<\/p>/);

  const a4 = buildExportHtml(note, { layout: "a4", dark: true, meta: false }, css);
  assert.match(a4, /size: 210mm 297mm/);
  assert.match(a4, /data-theme="dark"/);
  assert.match(a4, new RegExp(`background: ${tokenValue(css.global, true, "--bg")};`));
  assert.ok(!a4.includes('class="export__meta"'));
});

test("导出 HTML：标题只出现一次，元信息排在标题下面", () => {
  const same = buildExportHtml(note, { layout: "phone", dark: false, meta: true }, css);
  assert.equal(same.match(/反向传播<\/h1>/g)?.length, 1, "正文开头的同名一级标题不应重复");
  assert.ok(same.indexOf('class="export__title"') < same.indexOf('class="export__meta"'), "元信息应在标题下面");
  const other = buildExportHtml({ ...note, body: "# 别的标题\n\n正文" }, { layout: "phone", dark: false, meta: false }, css);
  assert.match(other, /<h1 class="export__title">反向传播<\/h1>/);
  assert.match(other, />别的标题<\/h1>/, "和标题不同的一级标题要保留");
  const escaped = buildExportHtml({ ...note, title: "<b>x</b>", body: "x" }, { layout: "phone", dark: false, meta: false }, css);
  assert.ok(escaped.includes("&lt;b&gt;x&lt;/b&gt;"));
});

test("tokenValue 读出浅色 / 深色主题的 token", () => {
  assert.equal(tokenValue(css.global, false, "--bg"), "#ffffff");
  assert.equal(tokenValue(css.global, true, "--bg"), "#1d1d1f");
  assert.equal(tokenValue(css.global, false, "--nope"), null);
});

test("文件名：去掉 Windows 不允许的字符，空标题有兜底", () => {
  assert.equal(exportFileName("反向传播"), "反向传播.pdf");
  assert.equal(exportFileName('a/b:c*?"<>|d'), "a b c d.pdf");
  assert.equal(exportFileName("  ...  "), "笔记.pdf");
  assert.equal(exportFileName(""), "笔记.pdf");
});

test("找浏览器：环境变量优先；Windows 先 Edge 后 Chrome；Linux 按 PATH 查", () => {
  const has = (files: string[]) => (file: string) => files.includes(file);
  const winEnv = { "PROGRAMFILES(X86)": "C:\\Program Files (x86)", PROGRAMFILES: "C:\\Program Files" };
  const edge = path.win32.join("C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe");
  const chrome = path.win32.join("C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");

  assert.equal(findBrowser({ platform: "win32", env: winEnv, exists: has([edge, chrome]) }), edge);
  assert.equal(findBrowser({ platform: "win32", env: winEnv, exists: has([chrome]) }), chrome);
  assert.equal(findBrowser({ platform: "win32", env: winEnv, exists: has([]) }), null);

  assert.equal(
    findBrowser({ platform: "win32", env: { ...winEnv, STUDY_PDF_BROWSER: "D:\\b.exe" }, exists: has(["D:\\b.exe", edge]) }),
    "D:\\b.exe",
  );
  assert.equal(
    findBrowser({ platform: "win32", env: { ...winEnv, STUDY_PDF_BROWSER: "D:\\missing.exe" }, exists: has([edge]) }),
    null,
    "配置了但不存在时不悄悄换成别的",
  );

  assert.equal(
    findBrowser({ platform: "linux", env: { PATH: "/usr/bin:/snap/bin" }, exists: has(["/snap/bin/chromium"]) }),
    "/snap/bin/chromium",
  );
  assert.equal(
    findBrowser({
      platform: "darwin",
      env: {},
      exists: has(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]),
    }),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  );
});

test("导出：笔记库里的图片嵌成 data:，读不到的显示缺失，超出总量的不再嵌", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sn-export-img-"));
  try {
    const store = new NoteStore({
      notesRoot: path.join(root, "notes"),
      historyDir: path.join(root, "history"),
      trashDir: path.join(root, "trash"),
    });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    fs.mkdirSync(path.join(store.notesRoot, "attachments"), { recursive: true });
    fs.writeFileSync(path.join(store.notesRoot, "attachments", "a.png"), png);
    const note = { title: "有图", body: "![](../attachments/a.png)\n\n![[a.png]]\n\n![丢了](../attachments/none.png)", updated: "", group: null, tags: [] };
    const css = { global: "", content: "", reading: "" };
    const html = buildExportHtml(note, { layout: "phone", dark: false, meta: false }, css, inlineImages(store, "inbox/x.md"));
    assert.equal((html.match(/src="data:image\/png;base64,/g) ?? []).length, 2);
    assert.match(html, /\[图片：丢了\]/);
    assert.doesNotMatch(html, /\/api\/files\//);
    const tight = buildExportHtml(note, { layout: "phone", dark: false, meta: false }, css, inlineImages(store, "inbox/x.md", png.length));
    assert.equal((tight.match(/src="data:image\/png;base64,/g) ?? []).length, 2, "同一张图只算一次总量");
    const tiny = buildExportHtml(note, { layout: "phone", dark: false, meta: false }, css, inlineImages(store, "inbox/x.md", 10));
    assert.equal((tiny.match(/src="data:/g) ?? []).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// —— 整本导出（book-003）——

test("rewriteBookLinks：书内链接变文档内跳转（不区分大小写兜底），书外的变成文字", () => {
  const anchors = new Map([["梯度下降", "ch-1"], ["Loop &amp; Run", "ch-2"]]);
  const html =
    '<p><a class="wikilink" data-target="梯度下降">看这里</a> <a class="wikilink" data-target="loop &amp; run">L</a> ' +
    '<a class="wikilink is-missing" data-target="书外" title="还没有这篇笔记，点击新建">书外</a></p>';
  assert.equal(
    rewriteBookLinks(html, anchors),
    '<p><a class="wikilink" href="#ch-1">看这里</a> <a class="wikilink" href="#ch-2">L</a> <span class="wikilink wikilink--out">书外</span></p>',
  );
});

test("demoteHeadings：标题降一级（h6 封顶）、加 id，# / ## 进书前目录", () => {
  const { html, toc } = demoteHeadings('<h1 id="x">甲 <code>a</code></h1><h2>乙</h2><h3>丙</h3><h6>丁</h6>', "ch-3");
  assert.equal(html, '<h2 id="ch-3-h1">甲 <code>a</code></h2><h3 id="ch-3-h2">乙</h3><h4 id="ch-3-h3">丙</h4><h6 id="ch-3-h4">丁</h6>');
  assert.deepEqual(toc, [
    { id: "ch-3-h1", text: "甲 a", depth: 1 },
    { id: "ch-3-h2", text: "乙", depth: 1 },
  ]);
});

test("整本导出 HTML：封面 + 总览、目录页、每章新起一页，章是 h1，书内链接可跳，原始 HTML 被转义", () => {
  const html = buildBookExportHtml(
    {
      title: "looprun",
      group: "agent/looprun",
      overview: { title: "looprun 目录", body: "# looprun 目录\n\n循环的总览。\n\n1. [[实现]]\n2. [[踩坑]]\n", path: "a.md" },
      chapters: [
        { title: "实现", body: "# 实现\n\n## 主循环\n\n见 [[踩坑]] 和 [[书外的笔记]] <script>x</script>\n", path: "b.md", from: null },
        { title: "踩坑", body: "### 小坑\n\n回到 [[实现#主循环]]\n", path: "c.md", from: "agent/trace" },
      ],
      date: "2026-11-18",
    },
    { layout: "a4", dark: false },
    css,
  );
  assert.match(html, /size: 210mm 297mm/);
  assert.match(html, /\.book-toc,\n\.book-chapter \{\n  break-before: page;/);
  assert.match(html, /<h1 class="export__title book-cover__title">looprun<\/h1>/);
  assert.match(html, /agent\/looprun · 2 章 · 2026-11-18 导出/);
  assert.match(html, /循环的总览/);
  assert.ok(!html.includes("looprun 目录</h"), "总览开头和目录同名的标题不再重复");
  // 章：h1 + 编号；章内 ## 降成 h3；### 降成 h4
  assert.match(html, /<section class="book-chapter" id="ch-1">\n<h1 class="export__title">1\. 实现<\/h1>/);
  assert.match(html, /<h3 id="ch-1-h1">主循环<\/h3>/);
  assert.match(html, /<h4 id="ch-2-h1">小坑<\/h4>/);
  assert.match(html, /<p class="book-chapter__from">来自 agent\/trace<\/p>/);
  // 链接
  assert.match(html, /<a class="wikilink" href="#ch-2">踩坑<\/a>/);
  assert.match(html, /<a class="wikilink" href="#ch-1">实现#主循环<\/a>/);
  assert.match(html, /<span class="wikilink wikilink--out">书外的笔记<\/span>/);
  assert.ok(!html.includes("<script>x</script>") && html.includes("&lt;script&gt;"));
  // 书前目录：章 + 原来的 # / ##（### 不进）
  assert.match(html, /<li class="book-toc__chapter"><a href="#ch-1">1\. 实现<\/a><\/li>\n<li class="book-toc__sub"><a href="#ch-1-h1">主循环<\/a><\/li>\n<li class="book-toc__chapter"><a href="#ch-2">2\. 踩坑<\/a><\/li>/);
  assert.ok(!/<script\b/.test(html));
});
