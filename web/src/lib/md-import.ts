/**
 * 拖入 .md 导入（import-001）前端的纯逻辑：挑文件、预选分组、预览用的标题与保留下来的键。
 * 真正的合并、写盘在服务端（server/import-md.ts）；这里的标题只是预填进框里，人确认后作为 title 发过去。
 */
import type { Filter } from "./nav.ts";

type FileLike = { name: string; type: string; size: number };

export function isMarkdownName(name: string): boolean {
  return /\.(md|markdown)$/i.test(name.trim());
}

/**
 * 拖进来的一组文件里挑要导入的：只认第一个 .md。
 * - md：要导入的那个（没有就是 null）
 * - skipped：被忽略的其它 .md 个数（一次只导一个）
 * - rejected：一个 .md 都没有、也不是图片时的提示
 */
export function pickMarkdown<T extends FileLike>(files: T[]): { md: T | null; skipped: number; rejected: string | null } {
  const mds = files.filter((file) => isMarkdownName(file.name));
  if (mds.length > 0) return { md: mds[0], skipped: mds.length - 1, rejected: null };
  if (files.length === 0) return { md: null, skipped: 0, rejected: null };
  return { md: null, skipped: 0, rejected: "只能导入 .md 文件" };
}

/** 拖动的东西里有没有文件（只有拖文件才显示「松开导入」） */
export function isFileDrag(types: readonly string[]): boolean {
  return types.includes("Files");
}

/** 拖动的东西里有图片（交给正文框插图，不走导入） */
export function hasImageItem(items: ReadonlyArray<{ kind: string; type: string }>): boolean {
  return items.some((item) => item.kind === "file" && item.type.startsWith("image/"));
}

/**
 * 框里预选哪个分组：拖到某个项目上 → 它；否则左栏当前选中的分组 / 正在连读的项目；都没有 → 不分组。
 */
export function defaultImportGroup(input: { dropGroup: string | null; bookGroup: string | null; filter: Filter }): string | null {
  if (input.dropGroup) return input.dropGroup;
  if (input.bookGroup) return input.bookGroup;
  return input.filter.kind === "group" ? input.filter.name : null;
}

const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
/** 应用自己管的键：导入时会改写，不算「保留下来的」 */
const MANAGED = new Set(["id", "title", "created", "updated", "type", "group"]);

function unquote(value: string): string {
  const v = value.trim();
  return (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")) ? v.slice(1, -1) : v;
}

/**
 * 预览：标题（文件头 title → 第一个 # 标题 → 文件名）、正文、文件头里会原样保留的键。
 * 文件头只认「每行都是 key: value 或缩进的续行」的块，和服务端一致；不像的整段算正文。
 */
export function previewMarkdown(fileName: string, content: string): { title: string; body: string; keptKeys: string[] } {
  const text = content.replace(/\r\n?/g, "\n");
  const match = FRONTMATTER_RE.exec(text);
  const lines = match ? match[1].split("\n") : [];
  const looksLike = match !== null && lines.every((line) => !line.trim() || /^[A-Za-z_][\w-]*\s*:/.test(line) || /^\s+/.test(line) || /^#/.test(line));
  const body = looksLike && match ? text.slice(match[0].length).replace(/^\n/, "") : text.replace(/^﻿/, "");
  const keys = looksLike ? lines.map((line) => /^([A-Za-z_][\w-]*)\s*:/.exec(line)?.[1]).filter((key): key is string => Boolean(key)) : [];
  const titleLine = looksLike ? lines.find((line) => /^title\s*:/.test(line)) : undefined;
  const fromHead = titleLine ? unquote(titleLine.replace(/^title\s*:/, "")) : "";
  const heading = /^\s{0,3}#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1]?.trim() ?? "";
  const fromName = fileName.replace(/\.(md|markdown)$/i, "").replace(/^\d{4}-\d{2}-\d{2}[-_]?/, "").replace(/[-_]+/g, " ").trim();
  return {
    title: fromHead || heading || fromName || "未命名",
    body,
    keptKeys: [...new Set(keys.filter((key) => !MANAGED.has(key)))],
  };
}

/** 正文里引用了本地图片（相对路径或 ![[图]]）：导入后这些图找不到，框里提醒一句 */
export function referencesLocalImages(body: string): boolean {
  if (/!\[\[[^\]]+\]\]/.test(body)) return true;
  const links = body.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)/g);
  for (const link of links) if (!/^(https?:|data:)/i.test(link[1])) return true;
  return false;
}

/** 开头几行给人看一眼 */
export function previewLines(body: string, max = 8): string {
  const lines = body.split("\n");
  const head = lines.slice(0, max).join("\n").trimEnd();
  return lines.length > max ? `${head}\n…` : head;
}
