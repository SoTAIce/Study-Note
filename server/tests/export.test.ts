import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildExportHtml, exportFileName, findBrowser, loadExportCss, tokenValue, type ExportNote } from "../export.ts";

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
