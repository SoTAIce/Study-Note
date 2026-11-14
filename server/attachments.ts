/**
 * 图片附件（media-001）：识别类型、起文件名、去重、原子写。
 *
 * - 统一放在笔记库的 attachments/ 里；文件名带内容指纹，同一张图只存一份。
 * - 类型只看文件头，不信前端给的名字和 MIME；只收 PNG / JPEG / GIF / WebP（SVG 能带脚本，不收）。
 * - 插入的是标准 Markdown `![](相对路径)`，路径相对于笔记所在目录，别的编辑器也认。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NoteStore } from "./store.ts";

export const ATTACH_DIR = "attachments";
/** 单张原图上限 */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
/** 上传接口的请求体上限（base64 会放大约 1/3，再留点余量） */
export const MAX_UPLOAD_BODY = 21 * 1024 * 1024;

export type ImageKind = "png" | "jpg" | "gif" | "webp";

/** 读文件接口能提供的类型（SVG 只读不收，响应时加 sandbox） */
export const SERVED_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

export class AttachmentError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 看文件头判断图片类型；不是支持的图片返回 null */
export function sniffImage(data: Uint8Array): ImageKind | null {
  const at = (i: number): number => data[i] ?? -1;
  const ascii = (from: number, text: string): boolean =>
    [...text].every((ch, i) => at(from + i) === ch.charCodeAt(0));
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => at(i) === b)) return "png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "jpg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp";
  return null;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * 拖进来的文件名 → 安全的文件名前缀：去掉扩展名、Windows 不允许的字符、空白和开头结尾的点，
 * 截到 40 字；什么都不剩（或是 CON 这类保留名）就返回空串。
 */
export function safeBaseName(name: string): string {
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  const cleaned = base
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "")
    .replace(/[\s#%[\]()]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  const cut = [...cleaned].slice(0, 40).join("").replace(/[-.]+$/g, "");
  return WINDOWS_RESERVED.test(cut) ? "" : cut;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** 浏览器给剪贴板图片起的通用名字（Chrome / Edge 都叫 image.png）：当作没有名字 */
const GENERIC_NAMES = /^(image|blob|clipboard|pasted|untitled|unnamed|screenshot)$/i;

/** `板书-a1b2c3d4.jpg`，没有名字（或是 image.png 这种通用名）时 `20261114-153012-a1b2c3d4.png` */
export function attachmentFileName(opts: { name?: string; kind: ImageKind; hash8: string; now: Date }): string {
  const named = opts.name ? safeBaseName(opts.name) : "";
  const base = GENERIC_NAMES.test(named) ? "" : named;
  const d = opts.now;
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${base || stamp}-${opts.hash8}.${opts.kind}`;
}

/** 从笔记所在目录到目标文件的相对路径（都用 / 分隔） */
export function relativeFromNote(noteRelPath: string, targetRelPath: string): string {
  const from = path.posix.dirname(noteRelPath.split("\\").join("/"));
  return path.posix.relative(from === "." ? "" : from, targetRelPath);
}

/** 插进正文的 Markdown */
export function imageMarkdown(noteRelPath: string, targetRelPath: string): string {
  return `![](${relativeFromNote(noteRelPath, targetRelPath)})`;
}

/**
 * 存一张图：类型不对 415，太大 413。同样内容的图已经在 attachments/ 里就直接复用。
 */
export function saveAttachment(
  store: NoteStore,
  input: { noteRelPath: string; name?: string; data: Buffer; now?: Date },
): { relPath: string; markdown: string; reused: boolean } {
  if (input.data.length === 0) throw new AttachmentError(400, "图片是空的");
  if (input.data.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(413, `图片超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB`);
  }
  const kind = sniffImage(input.data);
  if (!kind) throw new AttachmentError(415, "只支持 PNG、JPG、GIF、WebP 图片");

  const digest = crypto.createHash("sha256").update(input.data).digest("hex");
  const hash8 = digest.slice(0, 8);
  const dir = path.dirname(store.absPath(`${ATTACH_DIR}/x.${kind}`));
  fs.mkdirSync(dir, { recursive: true });

  // 去重：文件名以「-指纹.扩展名」结尾、内容完全相同
  const suffix = `-${hash8}.${kind}`;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(suffix)) continue;
    const existing = path.join(dir, entry);
    try {
      const same = crypto.createHash("sha256").update(fs.readFileSync(existing)).digest("hex") === digest;
      if (same) {
        const relPath = `${ATTACH_DIR}/${entry}`;
        return { relPath, markdown: imageMarkdown(input.noteRelPath, relPath), reused: true };
      }
    } catch {
      // 读不了的文件不当作重复
    }
  }

  let fileName = attachmentFileName({ name: input.name, kind, hash8, now: input.now ?? new Date() });
  let n = 2;
  while (fs.existsSync(path.join(dir, fileName))) {
    fileName = fileName.replace(/(-\d+)?(-[0-9a-f]{8}\.\w+)$/, `-${n}$2`);
    n += 1;
  }
  const relPath = `${ATTACH_DIR}/${fileName}`;
  const target = store.absPath(relPath);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, input.data);
  fs.renameSync(tmp, target);
  return { relPath, markdown: imageMarkdown(input.noteRelPath, relPath), reused: false };
}

/**
 * 读文件接口要提供的文件：只限笔记库内的图片，路径段不能是隐藏的。
 * 返回绝对路径和 MIME；不该提供的返回 null（调用方回 404）。越界由 store.absPath 抛错。
 */
export function servedFile(store: NoteStore, relPath: string): { abs: string; type: string } | null {
  const rel = relPath.split("\\").join("/");
  if (!rel || rel.split("/").some((part) => part === "" || part.startsWith("."))) return null;
  const type = SERVED_TYPES[path.extname(rel).toLowerCase()];
  if (!type) return null;
  const abs = store.absPath(rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return { abs, type };
}
