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
import {
  COALESCE_MS,
  compareNewestFirst,
  isValidNoteId,
  isValidVersionId,
  makeVersionId,
  parseVersionId,
  planPrune,
  type HistoryReason,
  type ParsedVersionId,
} from "./history.ts";

export type { HistoryReason } from "./history.ts";

/** 历史版本列表里的一项（不含正文）。 */
export type HistoryEntry = {
  versionId: string;
  /** 这份内容当时的保存时间（frontmatter 的 updated；读不到退回拍摄时间） */
  at: string;
  /** 快照是什么时候拍的（即被哪次保存覆盖掉的） */
  takenAt: string;
  reason: HistoryReason;
  title: string;
  chars: number;
  bytes: number;
};

export type HistoryVersion = HistoryEntry & { meta: NoteMeta; body: string; raw: string };

export class HistoryNotFoundError extends Error {
  readonly code = "NOT_FOUND" as const;
}

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
    opts: { checkpoint?: HistoryReason } = {},
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
    this.snapshot(current, opts.checkpoint);
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

  /**
   * 覆盖前给旧内容拍一份快照。
   * - 带 checkpoint：一定拍（打开后的第一次保存、AI 改写、恢复、AI 计划……）
   * - 不带：距上一份快照超过 10 分钟才拍，自动保存不再每 0.8 秒存一份
   * - 和最近一份完全相同就跳过；超过 2MB 的不存
   */
  private snapshot(note: StoredNote, checkpoint?: HistoryReason): void {
    if (Buffer.byteLength(note.raw, "utf8") > MAX_VERSION_BYTES) return;
    if (!isValidNoteId(note.id)) return;
    const dir = path.join(this.historyDir, note.id);
    const existing = this.scanHistory(note.id);
    const latest = existing[0];
    const nowMs = this.now().getTime();
    if (latest) {
      if (!checkpoint && nowMs - latest.takenAt < COALESCE_MS) return;
      try {
        if (fs.readFileSync(path.join(dir, `${latest.versionId}.md`), "utf8") === note.raw) return;
      } catch {
        // 读不了最近一份就当不同，照常拍
      }
    }
    fs.mkdirSync(dir, { recursive: true });
    this.seq += 1;
    const versionId = makeVersionId(new Date(nowMs), this.seq, randomUUID().slice(0, 4), checkpoint ?? "edit");
    fs.writeFileSync(path.join(dir, `${versionId}.md`), note.raw, "utf8");
    this.pruneHistory(note.id, nowMs);
  }

  /** 读出某篇的全部快照（新→旧），附带文件大小；不认识的文件名忽略。 */
  private scanHistory(noteId: string): Array<ParsedVersionId & { bytes: number }> {
    const dir = path.join(this.historyDir, noteId);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const out: Array<ParsedVersionId & { bytes: number }> = [];
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const parsed = parseVersionId(name.slice(0, -3));
      if (!parsed) continue;
      let bytes = 0;
      try {
        bytes = fs.statSync(path.join(dir, name)).size;
      } catch {
        continue;
      }
      out.push({ ...parsed, bytes });
    }
    return out.sort(compareNewestFirst);
  }

  private pruneHistory(noteId: string, nowMs: number): void {
    const dir = path.join(this.historyDir, noteId);
    for (const versionId of planPrune(this.scanHistory(noteId), nowMs)) {
      fs.rmSync(path.join(dir, `${versionId}.md`), { force: true });
    }
  }

  private loadVersion(noteId: string, versionId: string): HistoryVersion {
    if (!isValidNoteId(noteId) || !isValidVersionId(versionId)) {
      throw new Error("参数错误：版本 ID 不合法");
    }
    const parsedId = parseVersionId(versionId);
    const file = path.join(this.historyDir, noteId, `${versionId}.md`);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      throw new HistoryNotFoundError("这个历史版本不存在（可能已被自动清理）");
    }
    const takenAtIso = toLocalIso(new Date(parsedId!.takenAt));
    const parsed = parseNote(raw, { path: `${noteId}.md`, mtime: takenAtIso, id: noteId });
    return {
      versionId,
      at: parsed.meta.updated || takenAtIso,
      takenAt: takenAtIso,
      reason: parsedId!.reason,
      title: parsed.meta.title,
      chars: parsed.body.length,
      bytes: Buffer.byteLength(raw, "utf8"),
      meta: parsed.meta,
      body: parsed.body,
      raw,
    };
  }

  /** 列出某篇笔记的历史版本（新→旧）。读坏的文件跳过，不让一份坏快照拖垮整个列表。 */
  listHistory(noteId: string): HistoryEntry[] {
    if (!isValidNoteId(noteId)) throw new Error("参数错误：笔记 ID 不合法");
    const out: HistoryEntry[] = [];
    for (const v of this.scanHistory(noteId)) {
      try {
        const { meta: _meta, body: _body, raw: _raw, ...entry } = this.loadVersion(noteId, v.versionId);
        out.push(entry);
      } catch {
        // 跳过
      }
    }
    return out;
  }

  readVersion(noteId: string, versionId: string): HistoryVersion {
    return this.loadVersion(noteId, versionId);
  }

  /**
   * 恢复到某个历史版本：正文、标题、标签变回去；id / created / 分组保留现在的，updated 记为现在。
   * 恢复前一定先给当前内容拍一份 restore 快照，所以恢复本身也能撤销。
   */
  restoreVersion(relPath: string, versionId: string, baseHash: string): StoredNote {
    const current = this.read(relPath);
    if (baseHash !== current.hash) {
      throw new ConflictError(current.hash, current.mtime);
    }
    const version = this.loadVersion(current.id, versionId);
    const meta: NoteMeta = {
      ...current.parsed.meta,
      id: current.id,
      title: version.meta.title || current.parsed.meta.title,
      tags: [...(version.meta.tags ?? [])],
      updated: toLocalIso(this.now()),
    };
    this.snapshot(current, "restore");
    this.writeAtomic(relPath, serializeNote(meta, version.body));
    return this.read(relPath);
  }

  /** 回收站里给这篇起一个不重名的文件名：`时间戳-原文件名`，撞名就加序号前缀。 */
  private trashSlot(relPath: string, at: string): string {
    const base = `${at.replace(/[-:T+]/g, "").slice(0, 14)}-${path.basename(relPath)}`;
    fs.mkdirSync(this.trashDir, { recursive: true });
    let name = base;
    let n = 2;
    while (fs.existsSync(path.join(this.trashDir, name))) {
      name = `${n}-${base}`;
      n += 1;
    }
    return name;
  }

  private writeTrashSidecar(name: string, relPath: string, at: string): void {
    fs.writeFileSync(
      path.join(this.trashDir, `${name}.json`),
      JSON.stringify({ origPath: relPath, deletedAt: at }),
      "utf8",
    );
  }

  moveToTrash(relPath: string): { name: string } {
    const abs = this.abs(relPath);
    const at = toLocalIso(this.now());
    const name = this.trashSlot(relPath, at);
    fs.renameSync(abs, path.join(this.trashDir, name));
    this.writeTrashSidecar(name, relPath, at);
    return { name };
  }

  /**
   * 笔记在外部被删掉时，把编辑器里还开着的内容（可能含未保存修改）存进回收站，
   * 格式与 moveToTrash 相同，能走现有的恢复流程。
   * 回收站里已有同一路径、标题和正文都相同的条目（例如是在另一个标签页里删的）就不重复存。
   */
  salvageToTrash(relPath: string, meta: NoteMeta, body: string): { name: string; skipped: boolean } {
    this.abs(relPath); // 只做越界校验：文件本来就已经不在了
    if (!relPath.toLowerCase().endsWith(".md")) throw new Error(`只能存 .md 笔记：${relPath}`);
    for (const entry of this.listTrash()) {
      if (entry.origPath !== relPath) continue;
      try {
        const raw = fs.readFileSync(path.join(this.trashDir, entry.name), "utf8");
        const parsed = parseNote(raw, { path: relPath, mtime: entry.deletedAt });
        if (parsed.body === body && parsed.meta.title === meta.title) return { name: entry.name, skipped: true };
      } catch {
        // 读不了的条目不影响这次存
      }
    }
    const at = toLocalIso(this.now());
    const name = this.trashSlot(relPath, at);
    const content = serializeNote({ ...meta, updated: at }, body);
    fs.writeFileSync(path.join(this.trashDir, name), content, "utf8");
    this.writeTrashSidecar(name, relPath, at);
    return { name, skipped: false };
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
      this.snapshot(current, "backup-restore");
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
