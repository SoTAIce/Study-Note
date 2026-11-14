import { Marked, type Token, type TokensList } from "marked";

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

/** transformText 拿到的是已转义文本：生成双链前先还原，否则 & / 引号会被二次转义。 */
function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
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
  const inner = unescapeHtml(raw.slice(2, -2));
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
    // 任务框带固定类名，方便预览里改成可点（editor-006）；默认禁用
    checkbox({ checked }) {
      return `<input class="task-check" type="checkbox"${checked ? " checked" : ""} disabled> `;
    },
    link({ href, title, tokens }) {
      const safe = safeHref(href);
      if (!safe) return this.parser.parseInline(tokens ?? []);
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(safe)}"${titleAttr}>${this.parser.parseInline(tokens ?? [])}</a>`;
    },
  },
});

/**
 * 完整 Markdown → HTML（用于预览）。
 * interactiveTasks：任务框不禁用，预览里点了能勾选（只有可编辑的预览才开）。
 */
export function renderMarkdown(
  markdown: string,
  options: { interactiveTasks?: boolean; sourceLines?: boolean } = {},
): string {
  if (!markdown) return "";
  const raw = options.sourceLines ? renderWithLines(markdown) : md.parse(markdown, { async: false });
  const html = transformHtml(raw);
  // 笔记里的原始 HTML 已被转义，这里匹配到的只可能是上面 checkbox 渲染出来的
  return options.interactiveTasks ? html.replace(/(<input class="task-check" type="checkbox"(?: checked)?) disabled>/g, "$1>") : html;
}

/**
 * 每个顶层块的第一个标签上加 data-line（从 0 数的源码行号），分栏同步滚动用（editor-004）。
 * 逐块渲染，结果与整篇渲染一致；块开头不是标签（被转义的 HTML 块）时包一层 div。
 */
function renderWithLines(markdown: string): string {
  const tokens = md.lexer(markdown);
  let line = 0;
  let out = "";
  for (const token of tokens as Token[]) {
    const single = [token] as unknown as TokensList;
    single.links = tokens.links;
    const html = md.parser(single);
    if (token.type !== "space" && html.trim()) {
      const tagged = html.replace(/^(\s*<[a-zA-Z][a-zA-Z0-9]*)/, `$1 data-line="${line}"`);
      out += tagged === html ? `<div data-line="${line}">${html}</div>` : tagged;
    } else {
      out += html;
    }
    line += (token.raw.match(/\n/g) ?? []).length;
  }
  return out;
}

/** 任务行：可选的引用前缀 + 列表标记 + [ ] / [x] + 空白 + 文字（框后面没文字时 marked 不当任务框） */
const TASK_RE = /^((?: {0,3}>[ ]?)*\s*(?:[-*+]|\d{1,9}[.)])\s+)\[([ xX])\](?=[ \t]+\S)/;

/**
 * 切换第 index 个任务框（从 0 数，与预览里任务框出现的顺序一致；代码块里的不算）。
 * 找不到返回 null。
 */
export function toggleTask(markdown: string, index: number): string | null {
  const lines = markdown.split("\n");
  let fence: string | null = null;
  let seen = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const mark = fenceMatch[1];
      if (fence === null) fence = mark[0];
      else if (mark[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = TASK_RE.exec(line);
    if (!m) continue;
    if (seen === index) {
      const box = m[2] === " " ? "x" : " ";
      lines[i] = `${m[1]}[${box}]${line.slice(m[0].length)}`;
      return lines.join("\n");
    }
    seen += 1;
  }
  return null;
}

/** 单行文本 → HTML（用于标题、检索片段等）：转义后只处理双链与标签。 */
export function renderInline(text: string): string {
  if (!text) return "";
  return transformText(escapeHtml(text));
}
