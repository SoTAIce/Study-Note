import { createHash } from "node:crypto";
import path from "node:path";

export type NoteType = "note" | "idea" | "source";

export type NoteMeta = {
  id: string;
  title: string;
  created: string;
  updated: string;
  type: NoteType;
  tags: string[];
  /** 所属分组；缺省表示「未分组」。frontmatter 里的 `group:` 键。 */
  group?: string;
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

function parseTags(value: string | undefined): string[] {
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

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } | null {
  const fm = readFrontmatterBlock(raw);
  if (!fm) return null;
  const data: Record<string, string> = {};
  for (const line of fm.lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) continue;
    data[key] = line.slice(idx + 1).trim();
  }
  return { data, body: fm.body };
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

export function excerpt(body: string, max = 120): string {
  const text = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/!\[\[[^\]]*\]\]/g, " ")
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_all, title: string, alias?: string) => alias ?? title)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/[*_~]{1,3}/g, "")
    .replace(/\s+/g, " ")
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

/** 组名比较：去空白 + 不区分大小写（与 server/groups.ts 的 sameGroup 同义，避免循环依赖）。 */
function sameGroupName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
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
  if (meta.source) lines.push(`source: ${yamlValue(meta.source)}`);
  lines.push("---", "", body);
  return lines.join("\n");
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
  const type: NoteType =
    data.type && unquote(data.type) === "idea"
      ? "idea"
      : data.type && unquote(data.type) === "source"
        ? "source"
        : "note";
  const meta: NoteMeta = {
    id: data.id ? unquote(data.id).trim() : (fallback.id ?? ""),
    title: titleFromData || deriveTitle(body, fallback.path),
    created: createdAt,
    updated: updatedAt,
    type,
    tags: parseTags(data.tags),
  };
  if (data.source) meta.source = unquote(data.source).trim();
  const group = data.group ? unquote(data.group).trim() : "";
  if (group) meta.group = group;
  return { meta, body, hadFrontmatter: fm !== null };
}
