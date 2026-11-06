import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  contentHash,
  excerpt,
  extractTags,
  parseNote,
  patchFrontmatterGroup,
  serializeNote,
  slugify,
  type NoteMeta,
  type NoteType,
  type ParsedNote,
} from "./parse.ts";
import { normalizeGroupName, validateGroupName } from "./groups.ts";

/** 组名规范化 + 校验：非法直接抛中文错误，调用方不用重复判。 */
function cleanGroup(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const check = validateGroupName(raw);
  if (!check.ok) throw new Error(`参数错误：${check.error}`);
  return check.name;
}

function sameGroupName(a: string, b: string): boolean {
  return normalizeGroupName(a).toLowerCase() === normalizeGroupName(b).toLowerCase();
}

export class ConflictError extends Error {
  readonly code = "CONFLICT" as const;
  readonly currentHash: string;
  readonly diskUpdated: string;

  constructor(currentHash: string, diskUpdated: string) {
    super("文件已被外部修改");
    this.name = "ConflictError";
    this.currentHash = currentHash;
    this.diskUpdated = diskUpdated;
  }
}

export type StoredNote = {
  id: string;
  relPath: string;
  raw: string;
  parsed: ParsedNote;
  hash: string;
  mtime: string;
};

export type TrashedNote = { name: string; origPath: string; deletedAt: string };

const MAX_HISTORY = 20;
const MAX_VERSION_BYTES = 2 * 1024 * 1024;
const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** 真实路径；Windows 上必须用 .native，否则目录 junction 解析不出来。 */
function realPathOf(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    try {
      return fs.realpathSync(target);
    } catch {
      return path.resolve(target);
    }
  }
}

export function toLocalIso(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

const MAX_DERIVED_TITLE = 20;

/** 从正文头部取一个短标题：不留省略号（它会跑到文件名里），只截断。 */
function deriveTitleFromBody(body: string): string {
  const text = excerpt(body, MAX_DERIVED_TITLE + 2).replace(/…$/, "").trim();
  if (!text) return "";
  return text.length > MAX_DERIVED_TITLE ? text.slice(0, MAX_DERIVED_TITLE).trimEnd() : text;
}

export class NoteStore {
  readonly notesRoot: string;
  readonly historyDir: string;
  readonly trashDir: string;
  private readonly now: () => Date;
  private seq = 0;

  constructor(opts: {
    notesRoot: string;
    historyDir: string;
    trashDir: string;
    now?: () => Date;
  }) {
    this.notesRoot = path.resolve(opts.notesRoot);
    this.historyDir = path.resolve(opts.historyDir);
    this.trashDir = path.resolve(opts.trashDir);
    this.now = opts.now ?? (() => new Date());
    fs.mkdirSync(this.notesRoot, { recursive: true });
  }

  private abs(rel: string): string {
    const normalized = rel.split("/").join(path.sep);
    const target = path.resolve(this.notesRoot, normalized);
    if (target !== this.notesRoot && !target.startsWith(this.notesRoot + path.sep)) {
      throw new Error(`路径越界：${rel}`);
    }
    // 词法上在库内不够：Windows 的 directory junction（以及符号链接）会让真实位置跑到库外，
    // 而 fs.realpathSync 不解析 junction，必须用 .native。
    const realRoot = realPathOf(this.notesRoot);
    const realParent = realPathOf(path.dirname(target));
    if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
      throw new Error(`路径越界（链接）：${rel}`);
    }
    return target;
  }

  /** 相对路径 → 绝对路径（校验越界），供索引器等外部模块判断文件是否存在。 */
  absPath(relPath: string): string {
    return this.abs(relPath);
  }

  list(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          out.push(path.relative(this.notesRoot, full).split(path.sep).join("/"));
        }
      }
    };
    walk(this.notesRoot);
    return out.sort();
  }

  read(relPath: string): StoredNote {
    const abs = this.abs(relPath);
    const raw = fs.readFileSync(abs, "utf8");
    const mtime = toLocalIso(fs.statSync(abs).mtime);
    const parsed = parseNote(raw, { path: relPath, mtime });
    const id = parsed.meta.id || contentHash(relPath).slice(0, 8);
    return { id, relPath, raw, parsed, hash: contentHash(raw), mtime };
  }

  create(input: {
    title?: string;
    body: string;
    tags?: string[];
    type?: NoteType;
    source?: string;
    group?: string | null;
  }): StoredNote {
    const at = toLocalIso(this.now());
    const type: NoteType = input.type ?? "note";
    const body = input.body ?? "";
    const title = (input.title ?? "").trim() || deriveTitleFromBody(body) || "未命名";
    const tags: string[] = [];
    for (const tag of [...(input.tags ?? []), ...extractTags(body)]) {
      const clean = tag.trim();
      if (clean && !tags.includes(clean)) tags.push(clean);
    }
    const meta: NoteMeta = {
      id: randomUUID().slice(0, 8),
      title,
      created: at,
      updated: at,
      type,
      tags,
    };
    if (input.source) meta.source = input.source;
    const group = cleanGroup(input.group);
    if (group) meta.group = group;

    const date = at.slice(0, 10);
    const slug = slugify(title);
    const prefix = type === "idea" ? "inbox/" : "";
    let relPath = `${prefix}${date}-${slug}.md`;
    let n = 2;
    while (fs.existsSync(this.abs(relPath))) {
      relPath = `${prefix}${date}-${slug}-${n}.md`;
      n += 1;
    }
    this.writeAtomic(relPath, serializeNote(meta, body));
    return this.read(relPath);
  }

  /**
   * 指定路径创建（AI 计划专用）：不 slugify、不自动改名，路径已存在直接报错。
   * 与 create() 的区别只有"路径谁说了算"——笔记内容规则完全一致。
   */
  createAt(
    relPath: string,
    input: { title?: string; body: string; tags?: string[]; type?: NoteType; source?: string; group?: string | null },
  ): StoredNote {
    const rel = relPath.split("\\").join("/").replace(/^\/+/, "");
    if (!rel.toLowerCase().endsWith(".md")) throw new Error(`路径必须以 .md 结尾：${relPath}`);
    const target = this.abs(rel);
    if (fs.existsSync(target)) throw new Error(`文件已存在：${rel}`);
    const at = toLocalIso(this.now());
    const type: NoteType = input.type ?? "note";
    const body = input.body ?? "";
    const title = (input.title ?? "").trim() || deriveTitleFromBody(body) || "未命名";
    const tags: string[] = [];
    for (const tag of [...(input.tags ?? []), ...extractTags(body)]) {
      const clean = tag.trim();
      if (clean && !tags.includes(clean)) tags.push(clean);
    }
    const meta: NoteMeta = {
      id: randomUUID().slice(0, 8),
      title,
      created: at,
      updated: at,
      type,
      tags,
    };
    if (input.source) meta.source = input.source;
    const group = cleanGroup(input.group);
    if (group) meta.group = group;
    this.writeAtomic(rel, serializeNote(meta, body));
    return this.read(rel);
  }
  save(
    relPath: string,
    body: string,
    baseHash: string,
    patch: { title?: string; tags?: string[]; group?: string | null } = {},
  ): StoredNote {
    const current = this.read(relPath);
    if (baseHash !== current.hash) {
      throw new ConflictError(current.hash, current.mtime);
    }
    const at = toLocalIso(this.now());
    const meta: NoteMeta = {
      ...current.parsed.meta,
      id: current.id,
      updated: at,
    };
    if (patch.title) meta.title = patch.title;
    if (patch.tags) meta.tags = patch.tags.filter(Boolean);
    if (patch.group !== undefined) {
      const group = cleanGroup(patch.group);
      if (group) meta.group = group;
      else delete meta.group;
    }
    if (Buffer.byteLength(current.raw, "utf8") <= MAX_VERSION_BYTES) {
      this.saveHistory(current);
    }
    this.writeAtomic(relPath, serializeNote(meta, body));
    return this.read(relPath);
  }

  /**
   * 只改 frontmatter 里的 `group` 一行：不动正文、不动 `updated`、不写历史快照。
   * 移动/改名是整理动作而不是编辑，所以不能复用 save()。
   */
  setGroup(relPath: string, group: string | null, opts: { baseHash?: string } = {}): StoredNote {
    const current = this.read(relPath);
    if (opts.baseHash !== undefined && opts.baseHash !== current.hash) {
      throw new ConflictError(current.hash, current.mtime);
    }
    const want = group === null ? "" : cleanGroup(group) ?? "";
    if (group !== null && want && sameGroupName(current.parsed.meta.group ?? "", want)) return current;
    if (!want && !current.parsed.meta.group) return current;

    const patched = patchFrontmatterGroup(current.raw, want || null);
    if (!patched.changed) return current;

    // 没有 `updated:` 的笔记（比如刚用迁移脚本补了 group 的旧笔记）时间是从文件 mtime 推出来的：
    // 换文件会刷新 mtime，看上去就像「刚编辑过」，笔记会跳到列表顶部。整理不算编辑，所以把 mtime 还原。
    const abs = this.absPath(relPath);
    const before = fs.statSync(abs, { throwIfNoEntry: false });
    this.writeAtomic(relPath, patched.raw);
    if (before) {
      try {
        fs.utimesSync(abs, before.atime, before.mtime);
      } catch {
        // 还原 mtime 失败不影响内容正确性，忽略
      }
    }
    return this.read(relPath);
  }

  private saveHistory(note: StoredNote): void {
    const dir = path.join(this.historyDir, note.id);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = note.mtime.replace(/[-:T+]/g, "").slice(0, 17);
    this.seq += 1;
    const name = `${stamp}-${pad(this.seq, 3)}-${randomUUID().slice(0, 4)}.md`;
    fs.writeFileSync(path.join(dir, name), note.raw, "utf8");
    this.rotateHistory(dir);
  }

  private rotateHistory(dir: string): void {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const full = path.join(dir, f);
        return { full, at: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.at - a.at);
    for (const stale of files.slice(MAX_HISTORY)) {
      fs.rmSync(stale.full, { force: true });
    }
  }

  moveToTrash(relPath: string): { name: string } {
    const abs = this.abs(relPath);
    const at = toLocalIso(this.now());
    const base = `${at.replace(/[-:T+]/g, "").slice(0, 14)}-${path.basename(relPath)}`;
    fs.mkdirSync(this.trashDir, { recursive: true });
    let name = base;
    let n = 2;
    while (fs.existsSync(path.join(this.trashDir, name))) {
      name = `${n}-${base}`;
      n += 1;
    }
    fs.renameSync(abs, path.join(this.trashDir, name));
    fs.writeFileSync(
      path.join(this.trashDir, `${name}.json`),
      JSON.stringify({ origPath: relPath, deletedAt: at }),
      "utf8",
    );
    return { name };
  }

  listTrash(): TrashedNote[] {
    if (!fs.existsSync(this.trashDir)) return [];
    const out: TrashedNote[] = [];
    for (const file of fs.readdirSync(this.trashDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.trashDir, file), "utf8")) as {
          origPath?: string;
          deletedAt?: string;
        };
        if (!data.origPath) continue;
        out.push({
          name: file.slice(0, -".json".length),
          origPath: data.origPath,
          deletedAt: data.deletedAt ?? "",
        });
      } catch {
        continue;
      }
    }
    return out.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  restore(name: string): { relPath: string } {
    // 回收站条目名必须是一个纯文件名：不允许 ../、绝对路径、非 .md，防止把任意文件搬进笔记库
    if (
      !name ||
      name !== path.basename(name) ||
      name === "." ||
      name === ".." ||
      /[\\/]/.test(name) ||
      !name.toLowerCase().endsWith(".md")
    ) {
      throw new Error(`非法的回收站条目名：${name}`);
    }
    const source = path.resolve(this.trashDir, name);
    if (!source.startsWith(`${path.resolve(this.trashDir)}${path.sep}`)) {
      throw new Error(`非法的回收站条目名：${name}`);
    }
    const sidecar = `${source}.json`;
    if (!fs.existsSync(source)) throw new Error(`回收站里没有：${name}`);
    const data = fs.existsSync(sidecar)
      ? (JSON.parse(fs.readFileSync(sidecar, "utf8")) as { origPath?: string })
      : {};
    const origPath = data.origPath ?? path.basename(name).replace(/^\d+-/, "");
    let relPath = origPath;
    let abs = this.abs(relPath);
    let n = 1;
    while (fs.existsSync(abs)) {
      const ext = path.extname(relPath);
      relPath = `${relPath.slice(0, -ext.length)}-${n}${ext}`;
      abs = this.abs(relPath);
      n += 1;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.renameSync(source, abs);
    fs.rmSync(sidecar, { force: true });
    return { relPath };
  }

  /**
   * 从备份快照恢复一篇笔记：按**原路径**写回，保留快照里的 frontmatter
   * （id / created / tags），只把 `updated` 改成现在。
   *
   * 为什么不是走 create()：那会生成新 id、新路径 `日期-slug.md`，并丢掉
   * 原来的 created/tags —— 用户点"恢复"期望是"变回那天那篇"，不是多出一篇副本。
   */
  restoreFromSnapshot(relPath: string, raw: string, baseHash?: string): StoredNote {
    const abs = this.abs(relPath);
    const exists = fs.existsSync(abs);
    if (exists) {
      const current = this.read(relPath);
      if (baseHash && baseHash !== current.hash) {
        throw new ConflictError(current.hash, current.mtime);
      }
      if (Buffer.byteLength(current.raw, "utf8") <= MAX_VERSION_BYTES) {
        this.saveHistory(current);
      }
    }
    const at = toLocalIso(this.now());
    const parsed = parseNote(raw, { path: relPath, mtime: at });
    const meta: NoteMeta = {
      ...parsed.meta,
      id: parsed.meta.id || randomUUID().slice(0, 8),
      updated: at,
    };
    this.writeAtomic(relPath, serializeNote(meta, parsed.body));
    return this.read(relPath);
  }

  private writeAtomic(relPath: string, raw: string): void {
    const abs = this.abs(relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${randomUUID().slice(0, 8)}`;
    fs.writeFileSync(tmp, raw, "utf8");
    fs.renameSync(tmp, abs);
  }
}
