import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeGroupName } from "./groups.ts";

/** index：连读的目录笔记（book-001），链接顺序就是章节顺序。 */
export type NoteType = "note" | "idea" | "source" | "index";

export type NoteMeta = {
  id: string;
  title: string;
  created: string;
  updated: string;
  type: NoteType;
  tags: string[];
  /** 所属分组；缺省表示「未分组」。frontmatter 里的 `group:` 键。 */
  group?: string;
  /** 新建时套用的模板名（tpl-001）。frontmatter 里的 `template:` 键；模板删了也照样留着。 */
  template?: string;
  source?: string;
};

export type ParsedNote = { meta: NoteMeta; body: string; hadFrontmatter: boolean };

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const INSTANT_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function contentHash(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return String(JSON.parse(v));
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function offsetOf(instant: string): string {
  const m = INSTANT_RE.exec(instant.trim());
  if (m && m[4]) return m[4];
  if (instant.endsWith("Z")) return "Z";
  const off = new Date(instant).getTimezoneOffset();
  if (Number.isNaN(off)) return "";
  const sign = off <= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function normalizeInstant(value: string | undefined, fallback: string): string {
  const raw = value ? unquote(value) : "";
  if (!raw) return fallback;
  if (DATE_ONLY_RE.test(raw)) return `${raw}T00:00:00${offsetOf(fallback) || "Z"}`;
  const m = INSTANT_RE.exec(raw);
  if (!m) return fallback;
  const [, date, hm, sec, offset] = m;
  return `${date}T${hm}:${sec ?? "00"}${offset ?? (offsetOf(fallback) || "Z")}`;
}

function parseTags(value: string | undefined, list?: string[]): string[] {
  if (list) {
    const out: string[] = [];
    for (const item of list) {
      const tag = item.trim();
      if (tag && !out.includes(tag)) out.push(tag);
    }
    return out;
  }
  if (!value) return [];
  let text = value.trim();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const out: string[] = [];
  for (const part of text.split(",")) {
    const tag = unquote(part).trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** 光有 `---` 包裹不算 frontmatter：块里必须全是 `key: value` 形状，避免吞掉正文。 */
function looksLikeFrontmatter(block: string): boolean {
  let keys = 0;
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (/^[ \t]+\S/.test(rawLine)) continue;
    if (/^-{1,2}\s/.test(line.trimStart())) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) return false;
    const key = line.slice(0, idx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) return false;
    keys += 1;
  }
  return keys > 0;
}

/**
 * frontmatter 按「键」分组的行：一个顶格的 `key: value` 行，连同它下面的缩进行、`- ` 列表项
 * （块状列表 `tags:\n  - a`、多行值）。空行和认不出的行单独成组（key 为 null）。
 * 读（parseFrontmatter）和只改变了的键的写回（rewriteFrontmatter）共用这一份切法（data-001）。
 */
type FrontmatterEntry = { key: string | null; lines: string[] };

const KEY_LINE_RE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/;

function frontmatterEntries(lines: string[]): FrontmatterEntry[] {
  const out: FrontmatterEntry[] = [];
  for (const line of lines) {
    const m = KEY_LINE_RE.exec(line);
    if (m) {
      out.push({ key: m[1], lines: [line] });
      continue;
    }
    const last = out[out.length - 1];
    if (last?.key && line.trim() && (/^\s/.test(line) || /^-(\s|$)/.test(line))) {
      last.lines.push(line);
      continue;
    }
    out.push({ key: null, lines: [line] });
  }
  return out;
}

/** 键这一行冒号后面的值（去首尾空白，不去引号） */
function entryInline(entry: FrontmatterEntry): string {
  const m = KEY_LINE_RE.exec(entry.lines[0]);
  return m ? m[2].trim() : "";
}

/** 块状列表的各项：键这一行没写值，下面是 `- a` 这样的行 */
function entryList(entry: FrontmatterEntry): string[] | null {
  if (entryInline(entry)) return null;
  const items: string[] = [];
  for (const line of entry.lines.slice(1)) {
    const m = /^\s*-\s+(.*)$/.exec(line);
    if (m) items.push(unquote(m[1]));
  }
  return items.length ? items : null;
}

function parseFrontmatter(
  raw: string,
): { data: Record<string, string>; lists: Record<string, string[]>; body: string } | null {
  const fm = readFrontmatterBlock(raw);
  if (!fm) return null;
  const data: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  // 只认顶格的键：缩进的（嵌套对象里的 title: 之类）不能顶替外层的同名键
  for (const entry of frontmatterEntries(fm.lines)) {
    if (!entry.key) continue;
    data[entry.key] = entryInline(entry);
    const items = entryList(entry);
    if (items) lists[entry.key] = items;
    else delete lists[entry.key];
  }
  return { data, lists, body: fm.body };
}

export function deriveTitle(body: string, fallbackPath: string): string {
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s{0,3}#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) return m[1].trim();
  }
  const base = path.basename(fallbackPath).replace(/\.md$/i, "");
  const stripped = base.replace(/^\d{4}-\d{2}-\d{2}[-_]?/, "").replace(/[-_]+/g, " ").trim();
  return stripped || "未命名";
}

/** 表格分隔行：| --- | :---: | */
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** 一行去掉块级标记：标题 #、引用 >、列表 - / 1.、任务 [x]、表格竖线、分隔线 */
function stripBlockMarks(line: string): string {
  if (TABLE_RULE.test(line) || /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return "";
  let out = line
    .replace(/^\s{0,3}(>\s?)+/, "")
    // Obsidian callout 的类型标记（知识简卡的 [!card] 等）不进摘要
    .replace(/^\[![\w-]+\][-+]?\s*/, "")
    .replace(/^\s*([-*+]|\d{1,9}[.)])\s+(\[[ xX]\]\s+)?/, "")
    .replace(/^\s{0,3}#{1,6}\s+/, "");
  if (/^\s*\|.*\|\s*$/.test(out)) {
    out = out
      .trim()
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(" · ");
  }
  return out;
}

/**
 * 去掉正文里的 HTML 注释 `<!-- … -->`（模板的小节提示，tpl-001），换行原样保留，行号不变。
 * 围栏代码块和行内代码里的不动；没闭合的 `<!--` 也不动（渲染时它照旧被转义成文字）。
 */
export function stripHtmlComments(text: string): string {
  if (!text.includes("<!--")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let chunk: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    if (chunk.length) out.push(stripCommentsInText(chunk.join("\n")));
    chunk = [];
  };
  for (const line of lines) {
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      out.push(line);
      if (mark && mark[0] === fence[0] && mark.length >= fence.length && !line.trim().slice(mark.length).trim()) fence = null;
      continue;
    }
    if (mark) {
      flush();
      fence = mark;
      out.push(line);
      continue;
    }
    chunk.push(line);
  }
  flush();
  return out.join("\n");
}

/** 不含围栏代码的一段文字：行内代码先遮住，再去注释（注释里的换行留下）。 */
function stripCommentsInText(text: string): string {
  if (!text.includes("<!--")) return text;
  const codes: string[] = [];
  const masked = text.replace(/`[^`\n]*`/g, (code) => `\u0001${codes.push(code) - 1}\u0001`);
  return masked
    .replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ""))
    .replace(/\u0001(\d+)\u0001/g, (_all, i: string) => codes[Number(i)] ?? "");
}

export function excerpt(body: string, max = 120): string {
  body = stripHtmlComments(body);
  // 行内代码保留文字：先换成占位符，免得里面的 * _ 被当成强调去掉
  const codes: string[] = [];
  const text = body
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\r?\n/)
    .map(stripBlockMarks)
    .join("\n")
    .replace(/`([^`\n]*)`/g, (_all, code: string) => `\u0000${codes.push(code) - 1}\u0000`)
    .replace(/!\[\[[^\]]*\]\]/g, " ")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_all, title: string, alias?: string) => alias ?? title)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    // 强调标记：* / ~ 直接去；_ 只去单词边界上的（snake_case 保留）
    .replace(/[*~]{1,3}/g, "")
    .replace(/(^|[^\p{L}\p{N}])_{1,3}(?=\S)|(?<=\S)_{1,3}(?![\p{L}\p{N}])/gu, "$1")
    .replace(/\s+/g, " ")
    .replace(/\u0000(\d+)\u0000/g, (_all, i: string) => codes[Number(i)] ?? "")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

export function extractTags(body: string): string[] {
  const cleaned = body.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const re = /(^|[\s(（[【，。、；:：>])#([\p{Script=Han}\p{L}\p{N}_/-]+)/gu;
  const out: string[] = [];
  for (const m of cleaned.matchAll(re)) {
    const tag = m[2].replace(/[-/]+$/, "");
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

export function extractLinks(
  body: string,
): Array<{ title: string; display: string | null; heading: string | null }> {
  const cleaned = body.replace(/!\[\[[^\]]*\]\]/g, " ");
  const re = /\[\[([^\]|#]+?)(?:#([^\]|]+?))?(?:\|([^\]]+?))?\]\]/g;
  const out: Array<{ title: string; display: string | null; heading: string | null }> = [];
  for (const m of cleaned.matchAll(re)) {
    const title = m[1].trim();
    if (!title) continue;
    out.push({
      title,
      display: m[3] ? m[3].trim() : null,
      heading: m[2] ? m[2].trim() : null,
    });
  }
  return out;
}

export function slugify(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
    .replace(/[\s\u3000]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60)
    .replace(/^[.\s-]+|[.\s-]+$/g, "");
  return cleaned || "untitled";
}

function yamlValue(value: string): string {
  const needsQuote = value === "" || /[:#[\]{}&*!|>'"%@`,\n]/.test(value) || /^\s|\s$/.test(value) || /^-/.test(value);
  return needsQuote ? JSON.stringify(value) : value;
}

/** 写一行 `group: …`（带必要的 YAML 引号）；迁移脚本也用它，保证两处格式一致。 */
export function groupLine(value: string): string {
  return `group: ${yamlValue(value)}`;
}

export type FrontmatterBlock = {
  /** 文件开头的 BOM（没有就是空串）；调用方写回时要记得带上 */
  bom: string;
  /** 连同首尾 `---` 行与结尾换行的整块 */
  block: string;
  /** 块内每一行（不含 `---`） */
  lines: string[];
  /** 这份文件使用的换行符 */
  eol: string;
  /** 块后面的全部内容（正文） */
  body: string;
};

/**
 * 找文件里的 frontmatter 块。只有「全块都是 key: value 形状」才算
 * （正文里用 `---` 画的分隔线不算，否则会吞掉正文）。
 * 前导 BOM 会被摘下来放进返回值，方便调用方原样写回。
 */
export function readFrontmatterBlock(raw: string): FrontmatterBlock | null {
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = bom ? raw.slice(1) : raw;
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return null;
  if (!looksLikeFrontmatter(m[1])) return null;
  return {
    bom,
    block: m[0],
    lines: m[1].split(/\r?\n/),
    eol: text.includes("\r\n") ? "\r\n" : "\n",
    body: text.slice(m[0].length),
  };
}

function yamlList(values: string[]): string {
  return `[${values.map(yamlValue).join(", ")}]`;
}

/** 组名比较：规整空白（含 `/` 两边）+ 不区分大小写，与 server/groups.ts 的 sameGroup 同义。 */
function sameGroupName(a: string, b: string): boolean {
  return normalizeGroupName(a).toLowerCase() === normalizeGroupName(b).toLowerCase();
}

export function serializeNote(meta: NoteMeta, body: string): string {
  const lines = [
    "---",
    `id: ${yamlValue(meta.id)}`,
    `title: ${yamlValue(meta.title)}`,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    `type: ${meta.type}`,
    `tags: ${yamlList(meta.tags)}`,
  ];
  if (meta.group) lines.push(`group: ${yamlValue(meta.group)}`);
  if (meta.template) lines.push(templateLine(meta.template));
  if (meta.source) lines.push(`source: ${yamlValue(meta.source)}`);
  lines.push("---", "", body);
  return lines.join("\n");
}

/** 写一行 `template: …`（tpl-001）。 */
export function templateLine(value: string): string {
  return `template: ${yamlValue(value)}`;
}

/**
 * 只改 frontmatter 里的 `template` 一行（tpl-001），规则同 patchFrontmatterGroup：
 * 正文与其它键逐字节保留；null 删行；没有 frontmatter 时插最小块。
 * 与 group 不同的是名字只差大小写时也照改（模板改名可能只改大小写）。
 */
export function patchFrontmatterTemplate(raw: string, template: string | null): { raw: string; changed: boolean } {
  const want = template === null ? "" : template.trim();
  const fm = readFrontmatterBlock(raw);
  if (!fm) {
    if (!want) return { raw, changed: false };
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    return { raw: `---${eol}${templateLine(want)}${eol}---${eol}${eol}${raw}`, changed: true };
  }
  const { bom, lines, eol, body } = fm;
  const index = lines.findIndex((line) => TEMPLATE_LINE_RE.test(line));
  const current = index >= 0 ? unquote(lines[index].slice(lines[index].indexOf(":") + 1).trim()) : "";
  if (current === want) return { raw, changed: false };

  let next: string[];
  if (!want) next = lines.filter((_line, at) => at !== index);
  else if (index >= 0) next = lines.map((line, at) => (at === index ? templateLine(want) : line));
  else {
    // 紧跟 group 行；没有 group 就按 group 的规则（tags 之后）
    const groupAt = lines.findIndex((line) => GROUP_LINE_RE.test(line));
    const at = groupAt >= 0 ? groupAt + 1 : groupInsertAt(lines);
    next = [...lines.slice(0, at), templateLine(want), ...lines.slice(at)];
  }
  if (next.every((line) => !line.trim())) return { raw: `${bom}${stripLeadingEol(body)}`, changed: true };
  return { raw: `${bom}---${eol}${next.join(eol)}${eol}---${eol}${body}`, changed: true };
}

const TEMPLATE_LINE_RE = /^template\s*:/;

/**
 * 保存时写回文件头（data-001）：只改值真的变了的那几个键，其它一律原样保留——
 * 应用不认识的键（aliases、cssclass……）、原来的顺序、块状 tags 的写法、引号、换行风格、BOM。
 * - 管的键：id、title、created、updated、type、tags、group、template、source；
 * - 值没变（按解析后的含义比，不按字面）：那几行一个字不动；
 * - 变了：换成一行标准写法（tags 变了就写成 `[a, b]` 一行）；该删的（移出分组等）整组删掉；
 * - 缺的：插在前一个管的键后面（顺序同 serializeNote）。
 * 原文没有 frontmatter 时退回 serializeNote。
 */
/** 文件头里的时间和 want 是不是同一时刻（只认合法写法；写坏的、空的都算不同，要改写） */
function sameInstant(value: string, want: string): boolean {
  const raw = unquote(value);
  if (!INSTANT_RE.test(raw) && !DATE_ONLY_RE.test(raw)) return false;
  return normalizeInstant(raw, want) === want;
}

export function rewriteFrontmatter(raw: string, meta: NoteMeta, body: string): string {
  const fm = readFrontmatterBlock(raw);
  if (!fm) return serializeNote(meta, body);
  const eol = fm.block.includes("\r\n") ? "\r\n" : "\n";
  const entries = frontmatterEntries(fm.lines);
  const text = (entry: FrontmatterEntry) => unquote(entryInline(entry)).trim();
  const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((item, at) => item === b[at]);

  // [键, 想要的那一行（null = 不该有这个键）, 现有的值和想要的是否一样]
  const plan: Array<[string, string | null, (entry: FrontmatterEntry) => boolean]> = [
    ["id", `id: ${yamlValue(meta.id)}`, (e) => text(e) === meta.id],
    ["title", `title: ${yamlValue(meta.title)}`, (e) => text(e) === meta.title],
    ["created", `created: ${meta.created}`, (e) => sameInstant(entryInline(e), meta.created)],
    ["updated", `updated: ${meta.updated}`, (e) => sameInstant(entryInline(e), meta.updated)],
    ["type", `type: ${meta.type}`, (e) => text(e) === meta.type],
    ["tags", `tags: ${yamlList(meta.tags)}`, (e) => sameList(parseTags(entryInline(e), entryList(e) ?? undefined), meta.tags)],
    ["group", meta.group ? groupLine(meta.group) : null, (e) => !!meta.group && sameGroupName(text(e), meta.group)],
    ["template", meta.template ? templateLine(meta.template) : null, (e) => text(e) === meta.template],
    ["source", meta.source ? `source: ${yamlValue(meta.source)}` : null, (e) => text(e) === meta.source],
  ];

  let anchor = -1; // 上一个管的键所在的位置：缺的键插在它后面
  for (const [key, line, same] of plan) {
    // 同名键出现多次时解析取最后一个，这里也按最后一个改
    let at = -1;
    entries.forEach((entry, index) => {
      if (entry.key === key) at = index;
    });
    if (line === null) {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index].key === key) {
          entries.splice(index, 1);
          if (index <= anchor) anchor -= 1;
        }
      }
      continue;
    }
    if (at >= 0) {
      if (!same(entries[at])) entries[at] = { key, lines: [line] };
      anchor = at;
      continue;
    }
    const insertAt = anchor + 1;
    entries.splice(insertAt, 0, { key, lines: [line] });
    anchor = insertAt;
  }

  const lines = entries.flatMap((entry) => entry.lines);
  const gap = /^\r?\n/.test(fm.body) ? eol : "";
  return `${fm.bom}---${eol}${lines.join(eol)}${eol}---${eol}${gap}${body}`;
}

/** frontmatter 里 `group:` 行（行首、不缩进）。 */
const GROUP_LINE_RE = /^group\s*:/;

/**
 * 只改 frontmatter 里的 `group` 一行，正文与其它键逐字节保留。
 * - `group` 为 null：删掉该行；块因此变空则整块移除，只留正文。
 * - 原本没有 frontmatter：在最前面插入最小块 `---\ngroup: X\n---\n\n`。
 * - 组名相同（不区分大小写）：`changed: false`，内容原样返回。
 */
export function patchFrontmatterGroup(raw: string, group: string | null): { raw: string; changed: boolean } {
  const want = group === null ? "" : group.trim();
  const fm = readFrontmatterBlock(raw);
  if (!fm) {
    if (!want) return { raw, changed: false };
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    return { raw: `---${eol}${groupLine(want)}${eol}---${eol}${eol}${raw}`, changed: true };
  }

  const { bom, lines, eol, body } = fm;
  const index = lines.findIndex((line) => GROUP_LINE_RE.test(line));
  if (sameGroupName(index >= 0 ? unquote(lines[index].slice(lines[index].indexOf(":") + 1).trim()) : "", want)) {
    return { raw, changed: false };
  }

  let next: string[];
  if (!want) {
    next = lines.filter((_line, at) => at !== index);
  } else if (index >= 0) {
    next = lines.map((line, at) => (at === index ? groupLine(want) : line));
  } else {
    next = [...lines.slice(0, groupInsertAt(lines)), groupLine(want), ...lines.slice(groupInsertAt(lines))];
  }

  // 整块只剩空行 = 本来就是我们为归组临时插的最小块：连块带后面那个空行一起收走，
  // 这样「归组 → 移出」能逐字节回到原文件，不会凭空多一个空行。
  if (next.every((line) => !line.trim())) return { raw: `${bom}${stripLeadingEol(body)}`, changed: true };
  return { raw: `${bom}---${eol}${next.join(eol)}${eol}---${eol}${body}`, changed: true };
}

/**
 * group 行插在哪：优先紧跟 `tags:`，但块状 tags（`tags:` 后面跟 `  - a`）要继续往后跳过它的列表项，
 * 否则会插出一个非法 YAML。
 */
function groupInsertAt(lines: string[]): number {
  const tagsAt = lines.findIndex((line) => /^tags\s*:/.test(line));
  if (tagsAt < 0) return lines.length;
  let at = tagsAt + 1;
  while (at < lines.length && (/^\s+\S/.test(lines[at]) || /^\s*-/.test(lines[at]))) at += 1;
  return at;
}

/** 去掉开头的一个换行（\r\n 或 \n）。 */
function stripLeadingEol(text: string): string {
  if (text.startsWith("\r\n")) return text.slice(2);
  if (text.startsWith("\n")) return text.slice(1);
  return text;
}
export function parseNote(
  raw: string,
  fallback: { path: string; mtime: string; id?: string },
): ParsedNote {
  const fm = parseFrontmatter(raw);
  const body = fm ? fm.body.replace(/^\r?\n/, "") : raw;
  const data = fm?.data ?? {};
  const createdAt = normalizeInstant(data.created, fallback.mtime);
  const updatedAt = normalizeInstant(data.updated, fallback.mtime);
  const titleFromData = data.title ? unquote(data.title).trim() : "";
  // 没写 type 的笔记：放在 inbox/ 里就算收件箱想法（别的编辑器直接丢进去的文件也能出现在收件箱）
  const declared = data.type ? unquote(data.type).trim() : "";
  const inInbox = /^inbox[\\/]/i.test(fallback.path);
  const type: NoteType =
    declared === "idea" || (!declared && inInbox)
      ? "idea"
      : declared === "source"
        ? "source"
        : declared === "index"
          ? "index"
          : "note";
  const meta: NoteMeta = {
    id: data.id ? unquote(data.id).trim() : (fallback.id ?? ""),
    title: titleFromData || deriveTitle(body, fallback.path),
    created: createdAt,
    updated: updatedAt,
    type,
    tags: parseTags(data.tags, fm?.lists.tags),
  };
  if (data.source) meta.source = unquote(data.source).trim();
  // 手写的 `agent / looprun` 规整成 `agent/looprun`，索引和筛选只认一种写法
  const group = data.group ? normalizeGroupName(unquote(data.group)) : "";
  if (group) meta.group = group;
  const template = data.template ? unquote(data.template).trim() : "";
  if (template) meta.template = template;
  return { meta, body, hadFrontmatter: fm !== null };
}
