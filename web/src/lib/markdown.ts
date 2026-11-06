import { Marked } from "marked";

/**
 * Markdown 渲染（纯函数）。
 *
 * 策略：marked 负责标准语法；双链 / 标签用「文本节点后处理」实现——
 * 只改写标签之外的文本，绝不碰已经生成的 HTML 标签与属性，
 * 所以不会破坏 `<strong>`、`<a>` 这类结构。
 */

const SKIP_TAGS = new Set(["code", "pre", "script", "style", "textarea"]);

/** 双链或标签：两者用同一个正则一次扫完，避免二次替换互相污染。 */
const INLINE_RE =
  /(!?\[\[[^[\]\n]*?\]\])|(^|[\s([{（【「『,，.;；:：!！?？、>])(#[\p{L}_][\p{L}\p{N}_/\-]*)/gu;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 只允许安全协议，挡住 javascript: / vbscript: / 非常规 data:。 */
function safeHref(raw: string): string {
  const href = raw.trim();
  if (!href) return "";
  const lower = href.toLowerCase().replace(/[\u0000-\u0020]+/g, "");
  if (lower.startsWith("javascript:") || lower.startsWith("vbscript:")) return "";
  if (lower.startsWith("data:") && !lower.startsWith("data:image/")) return "";
  return href;
}

function renderWikilink(raw: string): string {
  // ![[图片]] 原样保留（Obsidian 的嵌入语法，本期不解析）。
  if (raw.startsWith("!")) return raw;
  const inner = raw.slice(2, -2);
  const pipe = inner.indexOf("|");
  const targetPart = pipe >= 0 ? inner.slice(0, pipe) : inner;
  const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : "";

  const hash = targetPart.indexOf("#");
  const target = (hash >= 0 ? targetPart.slice(0, hash) : targetPart).trim();
  const section = hash >= 0 ? targetPart.slice(hash + 1).trim() : "";

  // 没有笔记名（如 [[#小节]]）时不做双链，保持原样。
  if (!target) return raw;

  const display = alias || (section ? `${target}#${section}` : target);
  return `<a class="wikilink" data-target="${escapeHtml(target)}">${escapeHtml(display)}</a>`;
}

function renderTag(tag: string): string {
  // 与后端 extractTags 对齐：去掉结尾多余的 - 与 /。
  const clean = tag.replace(/[-/]+$/, "");
  return clean ? `<span class="tag-pill">${escapeHtml(clean)}</span>` : escapeHtml(tag);
}

/** 处理一段纯文本（可能来自 renderInline 的已转义文本）。 */
function transformText(text: string): string {
  if (!text) return text;
  let out = "";
  let last = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const index = match.index ?? 0;
    out += text.slice(last, index);
    if (match[1]) {
      out += renderWikilink(match[1]);
    } else {
      out += (match[2] ?? "") + renderTag(match[3] ?? "");
    }
    last = index + match[0].length;
  }
  out += text.slice(last);
  return out;
}

/** 在 HTML 文本节点上做双链 / 标签替换，跳过 code/pre/script/style/textarea。 */
function transformHtml(html: string): string {
  let out = "";
  let i = 0;
  const stack: string[] = [];
  const skipping = (): boolean => stack.some((name) => SKIP_TAGS.has(name));

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      const tail = html.slice(i);
      out += skipping() ? tail : transformText(tail);
      break;
    }

    if (lt > i) {
      const text = html.slice(i, lt);
      out += skipping() ? text : transformText(text);
    }

    // 注释原样拷贝，避免里面的 ">" 被误判为标签结尾。
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      const stop = end === -1 ? html.length : end + 3;
      out += html.slice(lt, stop);
      i = stop;
      continue;
    }

    // 找到标签结束的 ">"，跳过引号里的内容。
    let j = lt + 1;
    let quote = "";
    while (j < html.length) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      j += 1;
    }

    const tag = html.slice(lt, j + 1);
    out += tag;

    const m = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(tag);
    if (m) {
      const closing = m[1] === "/";
      const name = m[2].toLowerCase();
      if (SKIP_TAGS.has(name)) {
        if (closing) {
          const at = stack.lastIndexOf(name);
          if (at >= 0) stack.splice(at, 1);
        } else if (!tag.trimEnd().endsWith("/>")) {
          stack.push(name);
        }
      }
    }

    i = j + 1;
  }

  return out;
}

const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    // 原始 HTML 一律转义：笔记里出现 <script> 也只当文字显示。
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const safe = safeHref(href);
      if (!safe) return this.parser.parseInline(tokens ?? []);
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(safe)}"${titleAttr}>${this.parser.parseInline(tokens ?? [])}</a>`;
    },
  },
});

/** 完整 Markdown → HTML（用于预览）。 */
export function renderMarkdown(markdown: string): string {
  if (!markdown) return "";
  const html = md.parse(markdown, { async: false });
  return transformHtml(html);
}

/** 单行文本 → HTML（用于标题、检索片段等）：转义后只处理双链与标签。 */
export function renderInline(text: string): string {
  if (!text) return "";
  return transformText(escapeHtml(text));
}
