/**
 * 拖入 .md 导入成笔记（import-001）的纯逻辑：标题从哪来、文件头怎么合并。
 * 写盘由 store.importNote 做（原子写、不覆盖已有文件），路由在 api.ts 的 POST /api/notes/import。
 *
 * 文件头：应用不认识的键（aliases、cssclass、自定义键）、块状 tags 原样保留（复用 data-001 的 rewriteFrontmatter）；
 * title 用确认的标题，group 用选的分组（不分组就去掉），created 合法就留、否则用导入时间，
 * updated 是导入时间，id 没有或和库里已有的重复就换新的，type 不认识就当 note。正文一个字不改。
 */
import { parseNote, rewriteFrontmatter, serializeNote, type NoteMeta } from "./parse.ts";

/** 单个文件最大多少字节（UTF-8） */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

/** 文件头里的 id 只认这种形状：不能有空白、控制字符，也别太长 */
const ID_RE = /^[^\s\u0000-\u001f\u007f]{1,64}$/;

export type ImportInput = {
  /** 拖进来的文件名（只用来兜底取标题、判断扩展名） */
  fileName: string;
  /** 文件内容（前端用 File.text() 读出来的） */
  content: string;
  /** 框里确认的标题；空着就按文件自己来 */
  title?: string;
  /** 放进哪个分组；null = 不分组 */
  group: string | null;
  /** 导入时间（本地 ISO） */
  now: string;
  /** 这个 id 库里已经有了吗 */
  idTaken: (id: string) => boolean;
  newId: () => string;
};

export function isMarkdownFileName(name: string): boolean {
  return /\.(md|markdown)$/i.test(name.trim());
}

/** 统一成 LF、去掉开头的 BOM：库里的笔记都是这样 */
export function normalizeImported(content: string): string {
  return content.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

/** 导入前预览要用的：标题（文件头 title → 第一个 # 标题 → 文件名）和正文 */
export function previewImport(fileName: string, content: string): { title: string; body: string } {
  const parsed = parseNote(normalizeImported(content), { path: fileName.replace(/\.markdown$/i, ".md"), mtime: "" });
  return { title: parsed.meta.title, body: parsed.body };
}

/** 得到要写进新文件的内容和它的文件头 */
export function prepareImport(input: ImportInput): { meta: NoteMeta; text: string } {
  const raw = normalizeImported(input.content);
  const parsed = parseNote(raw, { path: input.fileName.replace(/\.markdown$/i, ".md"), mtime: input.now });
  const original = parsed.meta;
  const id = original.id && ID_RE.test(original.id) && !input.idTaken(original.id) ? original.id : input.newId();
  const meta: NoteMeta = {
    id,
    title: input.title?.trim() || original.title,
    // parseNote 遇到缺的或不合法的 created 会用 mtime（这里传的是导入时间）
    created: original.created,
    updated: input.now,
    type: original.type,
    tags: original.tags,
  };
  if (input.group) meta.group = input.group;
  if (original.template) meta.template = original.template;
  if (original.source) meta.source = original.source;
  const text = parsed.hadFrontmatter ? rewriteFrontmatter(raw, meta, parsed.body) : serializeNote(meta, parsed.body);
  return { meta, text };
}
