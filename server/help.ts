/**
 * 内置使用手册（help-001）：仓库里的 manual/*.md 是唯一的一份内容。
 * - GET    /api/help/manual            读章节 + 练习笔记装了没有
 * - POST   /api/help/manual/install    在「使用手册/练习」子项目里生成练习笔记（每章一篇 + 目录）；已经有了 409
 * - POST   /api/help/manual/reinstall  旧的练习笔记移进回收站，再生成最新版
 * - DELETE /api/help/manual            练习笔记移进回收站，清掉空的分组
 *
 * 练习笔记就是普通 .md（经 store.importNote 原子写），文件头多一行 `manual: <版本>`：
 * 只有带这一行、放在练习子项目里的才算练习笔记，删除和重新生成只动它们。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { removeGroupEntry, upsertGroup } from "./groups.ts";
import { readFrontmatterBlock } from "./parse.ts";
import type { NoteStore } from "./store.ts";
import { MANUAL_GROUP, MANUAL_INDEX_TITLE, type ManualChapter } from "../web/src/lib/help.ts";

export const DEFAULT_MANUAL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "manual");

export class HelpHttpError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "HelpHttpError";
    this.status = status;
    this.extra = extra;
  }
}

export type Manual = { version: string; chapters: ManualChapter[] };

/** 读 manual/：文件名排序就是章节顺序；文件头里的 title、part；版本 = 全部内容的哈希 */
export function loadManual(dir: string): Manual {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((name) => /^\d+.*\.md$/i.test(name)).sort();
  } catch {
    throw new HelpHttpError(500, "找不到使用手册（manual/ 目录）");
  }
  const hash = createHash("sha256");
  const chapters = files.map((file) => {
    const raw = fs.readFileSync(path.join(dir, file), "utf8").replace(/\r\n?/g, "\n");
    hash.update(file).update("\0").update(raw).update("\0");
    const fm = readFrontmatterBlock(raw);
    const field = (key: string) =>
      fm?.lines.find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1).trim() ?? "";
    return {
      slug: file.replace(/\.md$/i, ""),
      title: field("title") || file.replace(/\.md$/i, ""),
      part: field("part") || "其他",
      body: (fm ? fm.body : raw).replace(/^\n/, ""),
    };
  });
  return { version: hash.digest("hex").slice(0, 8), chapters };
}

/** 文件头里 `manual:` 的值；不是练习笔记返回 null */
export function manualVersionOf(raw: string): string | null {
  const fm = readFrontmatterBlock(raw);
  const line = fm?.lines.find((item) => /^manual\s*:/.test(item));
  if (!line) return null;
  return line.replace(/^manual\s*:/, "").trim().replace(/^["']|["']$/g, "") || null;
}

/** 目录笔记的正文：按部分分小节，每章一个双链（连读按这个顺序） */
export function indexBody(manual: Manual): string {
  const lines = [
    "# 使用手册",
    "",
    "这是一份**练习用的副本**：每章都能随便改、随便试。练完在「帮助」里点「删除练习笔记」，它们会进回收站；手册更新后点「重新生成」换成最新版。",
  ];
  let part = "";
  for (const chapter of manual.chapters) {
    if (chapter.part !== part) {
      part = chapter.part;
      lines.push("", `## ${part}`, "");
    }
    lines.push(`- [[${chapter.title}]]`);
  }
  return `${lines.join("\n")}\n`;
}

type HelpDeps = {
  db: DatabaseSync;
  store: NoteStore;
  dataDir: string;
  manualDir: string;
  reindex: (relPath: string) => void;
  removeFromIndex: (relPath: string) => void;
};

type Row = { id: string; path: string };

export function createHelpService(deps: HelpDeps) {
  /** 练习子项目里带 manual: 行的笔记 */
  function practiceNotes(): Array<Row & { version: string }> {
    const rows = deps.db
      .prepare("SELECT id, path FROM notes WHERE lower(group_name) = lower(?)")
      .all(MANUAL_GROUP) as Row[];
    const out: Array<Row & { version: string }> = [];
    for (const row of rows) {
      let raw: string;
      try {
        raw = deps.store.read(row.path).raw;
      } catch {
        continue;
      }
      const version = manualVersionOf(raw);
      if (version) out.push({ ...row, version });
    }
    return out;
  }

  function status(manual: Manual) {
    const notes = practiceNotes();
    return {
      version: manual.version,
      chapters: manual.chapters,
      installed: { count: notes.length, version: notes[0]?.version ?? null },
    };
  }

  function writeOne(fileName: string, content: string, title: string): { id: string; relPath: string } {
    const note = deps.store.importNote({
      fileName,
      content,
      title,
      group: MANUAL_GROUP,
      idTaken: (id) => deps.db.prepare("SELECT 1 FROM notes WHERE id = ?").get(id) !== undefined,
    });
    deps.reindex(note.relPath);
    return { id: note.id, relPath: note.relPath };
  }

  function install(manual: Manual) {
    if (practiceNotes().length > 0) {
      throw new HelpHttpError(409, "已经生成过练习笔记了；要换成最新版请用「重新生成」");
    }
    upsertGroup(deps.dataDir, MANUAL_GROUP);
    const head = (title: string, extra = "") => `---\ntitle: ${title}\n${extra}manual: ${manual.version}\n---\n\n`;
    const index = writeOne("index.md", `${head(MANUAL_INDEX_TITLE, "type: index\n")}${indexBody(manual)}`, MANUAL_INDEX_TITLE);
    for (const chapter of manual.chapters) {
      writeOne(`${chapter.slug}.md`, `${head(chapter.title)}${chapter.body}`, chapter.title);
    }
    return { ...status(manual), indexId: index.id, group: MANUAL_GROUP };
  }

  /** 练习笔记移进回收站；组里没别的笔记了就把分组（和空的父分组）也清掉。返回移走的 id（前端据此关掉开着的那几篇） */
  function remove(): string[] {
    const notes = practiceNotes();
    for (const note of notes) {
      deps.store.moveToTrash(note.path);
      deps.removeFromIndex(note.path);
    }
    for (const group of [MANUAL_GROUP, MANUAL_GROUP.split("/")[0]]) {
      const left = deps.db
        .prepare("SELECT count(*) AS n FROM notes WHERE lower(group_name) = lower(?) OR lower(group_name) LIKE lower(?)")
        .get(group, `${group}/%`) as { n: number };
      if (left.n === 0) removeGroupEntry(deps.dataDir, group);
    }
    return notes.map((note) => note.id);
  }

  return {
    read: () => status(loadManual(deps.manualDir)),
    install: () => install(loadManual(deps.manualDir)),
    reinstall: () => {
      const manual = loadManual(deps.manualDir);
      const trashedIds = remove();
      return { ...install(manual), trashed: trashedIds.length, trashedIds };
    },
    remove: () => {
      const trashedIds = remove();
      return { ...status(loadManual(deps.manualDir)), trashed: trashedIds.length, trashedIds };
    },
  };
}

/** 路由：不是帮助相关的返回 undefined，交给后面的路由 */
export function createHelpRoutes(service: ReturnType<typeof createHelpService>) {
  return (method: string, route: string[]): unknown => {
    if (route[0] !== "help" || route[1] !== "manual") return undefined;
    if (route.length === 2 && method === "GET") return service.read();
    if (route.length === 2 && method === "DELETE") return service.remove();
    if (route.length === 3 && route[2] === "install" && method === "POST") return service.install();
    if (route.length === 3 && route[2] === "reinstall" && method === "POST") return service.reinstall();
    return undefined;
  };
}
