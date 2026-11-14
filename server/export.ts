/**
 * 导出手机可读 PDF（export-001）。方案：docs/superpowers/specs/2026-11-14-reading-mode-pdf-export-design.md
 *
 * 1. buildExportHtml：用前端同一个 renderMarkdown 渲染（原始 HTML 照常转义），内联 global.css + content.css +
 *    reading.css + 版式样式，生成完全自包含、禁止脚本的 HTML。
 * 2. printPdf：用电脑上已有的 Edge / Chrome 在后台打开这个文件，经调试管道（--remote-debugging-pipe）
 *    调 Page.printToPDF。用独立的临时用户目录，不和正在用的浏览器抢同一个配置。
 *    不用 --print-to-pdf 命令行参数：它配上独立用户目录时会一直挂住（2026-11-14 实测）。
 *
 * 不引入任何依赖：只用 Node 自带的 child_process 和系统里已有的浏览器。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { escapeHtml, renderMarkdown, type ImageContext } from "../web/src/lib/markdown.ts";
import { servedFile } from "./attachments.ts";
import type { NoteStore } from "./store.ts";

export type ExportLayout = "phone" | "a4";

export const LAYOUTS: Record<ExportLayout, { width: string; height: string; margin: string; fontSize: string }> = {
  /** 手机按宽度适配后缩放约 0.68，12pt 显示出来与手机 App 正文相当 */
  phone: { width: "100mm", height: "178mm", margin: "8mm 7mm 11mm", fontSize: "12pt" },
  a4: { width: "210mm", height: "297mm", margin: "18mm 18mm 20mm", fontSize: "11pt" },
};

export type ExportNote = {
  title: string;
  body: string;
  updated: string;
  group: string | null;
  tags: string[];
};

export type ExportOptions = {
  layout: ExportLayout;
  dark: boolean;
  /** 第一页顶部的「更新日期 · 分组 · 标签」 */
  meta: boolean;
};

const stylesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "src", "styles");

/** 正文排版样式：每次导出时读，改了样式不用重启服务 */
export function loadExportCss(dir = stylesDir): { global: string; content: string; reading: string } {
  const read = (name: string): string => fs.readFileSync(path.join(dir, name), "utf8");
  return { global: read("global.css"), content: read("content.css"), reading: read("reading.css") };
}

/** 从 global.css 里取某个主题下某个 token 的值（@page 里用不了 var()） */
export function tokenValue(globalCss: string, dark: boolean, name: string): string | null {
  const selector = dark ? ':root[data-theme="dark"]' : ":root {";
  const start = globalCss.indexOf(selector);
  if (start === -1) return null;
  const end = globalCss.indexOf("}", start);
  const block = globalCss.slice(start, end === -1 ? undefined : end);
  const match = new RegExp(`${name.replace(/[-]/g, "\\-")}\\s*:\\s*([^;]+);`).exec(block);
  return match ? match[1].trim() : null;
}

/** 下载用的文件名：去掉 Windows 文件名里不允许的字符 */
export function exportFileName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 80)
    .trim();
  return `${cleaned || "笔记"}.pdf`;
}

function pageCss(options: ExportOptions, css: { global: string }): string {
  const layout = LAYOUTS[options.layout];
  const pageBg = tokenValue(css.global, options.dark, "--bg") ?? "white";
  const faint = tokenValue(css.global, options.dark, "--text-faint") ?? "gray";
  return `
@page {
  size: ${layout.width} ${layout.height};
  margin: ${layout.margin};
  background: ${pageBg};
  @bottom-center {
    content: counter(page) " / " counter(pages);
    font-family: var(--font-ui);
    font-size: 7.5pt;
    color: ${faint};
  }
}
html {
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
  background: var(--bg);
}
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
}
.export {
  font-size: ${layout.fontSize};
}
.export .preview.reading {
  line-height: 1.6;
}
.export__meta {
  margin: 0 0 1.2em;
  font-size: 0.78em;
  color: var(--text-faint);
}
.export__title {
  margin: 0 0 0.3em;
  font-family: var(--font-display);
  font-size: 1.6em;
  font-weight: 600;
  line-height: 1.25;
}
/* 打印时表格回到正常排版：铺满版心，单元格折行，什么都不截掉 */
.export .preview.reading table {
  display: table;
  width: 100%;
  font-size: 0.85em;
}
.export .preview.reading th,
.export .preview.reading td {
  min-width: 0;
  padding: 0.35em 0.5em;
}
.export .preview.reading pre {
  padding: 0.7em 0.8em;
}
/* 双链在单篇 PDF 里点不了：保留文字，加淡下划线示意 */
.export .preview.reading a.wikilink {
  color: inherit;
  text-decoration: underline dotted var(--line-strong);
}
`;
}

/** 单篇导出里嵌入图片的总量上限：超过后后面的图片显示成「图片缺失」，避免生成卡死 */
export const EXPORT_IMAGE_BUDGET = 50 * 1024 * 1024;

/**
 * 导出时把笔记库里的图片读出来嵌成 data: 地址（media-001）：
 * PDF 页面的内容安全策略只放行 data: 图片，不需要放宽。
 * 依次尝试候选位置；读不到、或超出总量的返回 null。
 */
export function inlineImages(store: NoteStore, notePath: string, budget = EXPORT_IMAGE_BUDGET): ImageContext {
  let used = 0;
  const cache = new Map<string, string | null>();
  return {
    notePath,
    localSrc: (candidates) => {
      for (const rel of candidates) {
        if (cache.has(rel)) {
          const hit = cache.get(rel);
          if (hit) return hit;
          continue;
        }
        let file: { abs: string; type: string } | null = null;
        try {
          file = servedFile(store, rel);
        } catch {
          file = null;
        }
        if (!file) {
          cache.set(rel, null);
          continue;
        }
        const data = fs.readFileSync(file.abs);
        if (used + data.length > budget) return null;
        used += data.length;
        const uri = `data:${file.type};base64,${data.toString("base64")}`;
        cache.set(rel, uri);
        return uri;
      }
      return null;
    },
  };
}

/** 生成导出用的完整 HTML（纯函数：样式由调用方传入；images 决定本地图片怎么嵌） */
export function buildExportHtml(
  note: ExportNote,
  options: ExportOptions,
  css: { global: string; content: string; reading: string },
  images?: ImageContext,
): string {
  // 正文第一行就是同名一级标题时，拿掉它，由下面统一的标题代替：元信息才能排在标题下面
  const source = note.body.replace(/^\s+/, "");
  const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
  const firstHeading = /^#\s+(.+?)\s*#*\s*$/.exec(firstLine);
  const body = renderMarkdown(
    firstHeading && firstHeading[1].trim() === note.title.trim() ? source.slice(firstLine.length) : note.body,
    { images },
  );
  const metaParts = [
    note.updated ? `${note.updated.slice(0, 10)} 更新` : null,
    note.group ? `分组 ${note.group}` : null,
    note.tags.length > 0 ? note.tags.map((tag) => `#${tag}`).join(" ") : null,
  ].filter((part): part is string => Boolean(part));

  return `<!doctype html>
<html lang="zh-CN" data-theme="${options.dark ? "dark" : "light"}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: http: https:; font-src data:">
<title>${escapeHtml(note.title || "笔记")}</title>
<style>
${css.global}
${css.content}
${css.reading}
${pageCss(options, css)}
</style>
</head>
<body>
<article class="export">
<h1 class="export__title">${escapeHtml(note.title || "无标题")}</h1>
${options.meta && metaParts.length > 0 ? `<p class="export__meta">${escapeHtml(metaParts.join(" · "))}</p>` : ""}
<div class="preview reading">
${body}
</div>
</article>
</body>
</html>
`;
}

// —— 找浏览器 ——

export type BrowserLookup = {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  exists: (file: string) => boolean;
};

/** 按「环境变量 → Edge → Chrome → Chromium」的顺序找一个能用的浏览器 */
export function findBrowser({ platform, env, exists }: BrowserLookup): string | null {
  const configured = env.STUDY_PDF_BROWSER?.trim();
  if (configured) return exists(configured) ? configured : null;

  const candidates: string[] = [];
  if (platform === "win32") {
    const join = path.win32.join;
    const roots = [env["PROGRAMFILES(X86)"] ?? env["ProgramFiles(x86)"], env.PROGRAMFILES ?? env.ProgramFiles, env.LOCALAPPDATA];
    for (const root of roots) if (root) candidates.push(join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
    for (const root of roots) if (root) candidates.push(join(root, "Google", "Chrome", "Application", "chrome.exe"));
  } else if (platform === "darwin") {
    candidates.push(
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    const dirs = (env.PATH ?? "").split(path.posix.delimiter).filter(Boolean);
    for (const name of ["microsoft-edge", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
      for (const dir of dirs) candidates.push(path.posix.join(dir, name));
    }
  }
  return candidates.find((file) => exists(file)) ?? null;
}

export function defaultBrowser(): string | null {
  return findBrowser({
    platform: process.platform,
    env: process.env,
    exists: (file) => {
      try {
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    },
  });
}

// —— 打印 ——

export class PdfError extends Error {}

/**
 * 用浏览器把 HTML 打印成 PDF。经调试管道通信：fd 3 写命令，fd 4 读回复，消息以 \0 分隔。
 */
export async function printPdf(browser: string, html: string, opts: { timeoutMs?: number } = {}): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "snpdf-"));
  const profile = path.join(workDir, "profile");
  const input = path.join(workDir, "export.html");
  fs.writeFileSync(input, html, "utf8");

  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    `--user-data-dir=${profile}`,
    "--remote-debugging-pipe",
    "about:blank",
  ];
  // Linux 下以 root 运行时 Chromium 拒绝启用沙箱（容器）；有的 Linux（如 GitHub 的 Ubuntu）不允许普通用户建沙箱，
  // 用 STUDY_PDF_NO_SANDBOX=1 显式关掉。导出的 HTML 禁止脚本、只读本地文件。Windows / macOS 默认不加
  if (
    (process.platform === "linux" && process.getuid?.() === 0) ||
    process.env.STUDY_PDF_NO_SANDBOX === "1"
  ) {
    args.unshift("--no-sandbox");
  }

  const child = spawn(browser, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: true });
  const toBrowser = child.stdio[3] as NodeJS.WritableStream;
  const fromBrowser = child.stdio[4] as NodeJS.ReadableStream;
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-2000);
  });

  let seq = 0;
  let buffer = "";
  const pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void }>();
  const waiters: Array<{ method: string; resolve: () => void }> = [];
  let failed: Error | null = null;
  const failAll = (err: Error): void => {
    if (failed) return;
    failed = err;
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  };

  fromBrowser.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let cut: number;
    while ((cut = buffer.indexOf("\0")) >= 0) {
      const raw = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 1);
      let message: { id?: number; method?: string; result?: unknown; error?: { message: string } };
      try {
        message = JSON.parse(raw);
      } catch {
        continue;
      }
      if (message.id !== undefined) {
        const entry = pending.get(message.id);
        if (!entry) continue;
        pending.delete(message.id);
        if (message.error) entry.reject(new PdfError(message.error.message));
        else entry.resolve(message.result);
      } else if (message.method) {
        for (const waiter of waiters.filter((w) => w.method === message.method)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
    }
  });
  child.on("error", (err) => failAll(new PdfError(`浏览器启动失败：${err.message}`)));
  // 浏览器没起来时往管道写会 EPIPE：当成启动失败，别变成未捕获异常
  (toBrowser as NodeJS.WritableStream & { on: (e: "error", f: (err: Error) => void) => void }).on("error", (err) =>
    failAll(new PdfError(`浏览器连接失败：${err.message}`)),
  );
  fromBrowser.on("error", (err: Error) => failAll(new PdfError(`浏览器连接失败：${err.message}`)));
  child.on("exit", (code) => failAll(new PdfError(`浏览器意外退出（${code}）${stderr ? `：${stderr.trim().slice(-300)}` : ""}`)));

  const send = <T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (failed) return reject(failed);
      seq += 1;
      pending.set(seq, { resolve, reject });
      toBrowser.write(`${JSON.stringify({ id: seq, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  const nextEvent = (method: string): Promise<void> => new Promise((resolve) => waiters.push({ method, resolve }));

  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PdfError(`生成 PDF 超时（${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
  });

  try {
    const work = (async (): Promise<Buffer> => {
      const { targetId } = await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
      await send("Page.enable", {}, sessionId);
      const loaded = nextEvent("Page.loadEventFired");
      await send("Page.navigate", { url: pathToFileURL(input).href }, sessionId);
      await loaded;
      const { data } = await send<{ data: string }>(
        "Page.printToPDF",
        {
          printBackground: true,
          preferCSSPageSize: true,
          displayHeaderFooter: false,
          generateDocumentOutline: true,
          generateTaggedPDF: true,
        },
        sessionId,
      );
      return Buffer.from(data, "base64");
    })();
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    child.removeAllListeners("exit");
    // 浏览器可能不等回复就退出：最多等 2 秒
    await Promise.race([
      send("Browser.close").catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2000).unref()),
    ]);
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      const kill = setTimeout(() => {
        child.kill();
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
    });
    // Windows 上浏览器刚退出时文件可能还被占着：多试几次
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
