import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ChangeEvent } from "./events.ts";
import { diffIndexed, type IndexChanges, type IndexedShape } from "./index-diff.ts";
import { indexCards, matchRenamed, parseCards, type IndexedCard } from "./cards.ts";
import { contentHash, excerpt, extractLinks, extractTags } from "./parse.ts";
import { toLocalIso, type NoteStore, type StoredNote } from "./store.ts";

const DEBOUNCE_MS = 250;
/** 自己的写入事件通常几毫秒内就到；超过这个窗口的事件当外部修改，正常索引。 */
const SELF_WRITE_WINDOW_MS = 800;
/** reindexAll 每写这么多篇提交一次事务 */
const REINDEX_BATCH = 500;

/** indexFile 的结果：保存接口据此告诉前端要不要刷新左栏 / 反链 */
export type IndexResult = {
  id: string;
  hash: string;
  excerpt: string;
  /** 索引里的标签（frontmatter + 正文 #标签），与列表接口一致 */
  tags: string[];
  changes: IndexChanges;
};

export class Indexer {
  private readonly db: DatabaseSync;
  private readonly store: NoteStore;
  private readonly now: () => Date;
  private readonly ignored = new Map<string, number>();
  private readonly listeners = new Set<(event: ChangeEvent) => void>();
  /** 简卡改了标题、认回原卡时通知（复习日志记别名，srs-001） */
  private cardRenamed: ((newId: string, oldId: string) => void) | null = null;
  /** reindexAll 期间不逐篇发事件，结束时发一次 resync */
  private muted = 0;

  constructor(deps: { db: DatabaseSync; store: NoteStore; now?: () => Date }) {
    this.db = deps.db;
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
  }

  onCardRenamed(listener: (newId: string, oldId: string) => void): void {
    this.cardRenamed = listener;
  }

  private cardsOf(noteId: string): IndexedCard[] {
    return this.db
      .prepare("SELECT id, ord, kind, title, body, line FROM cards WHERE note_id = ? ORDER BY ord")
      .all(noteId) as IndexedCard[];
  }

  /** 订阅索引变化（外部编辑、应用自己的写入、整体重建都会发）。返回取消订阅函数。 */
  onChange(listener: (event: ChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: ChangeEvent): void {
    if (this.muted > 0) return;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        // 某个订阅者出错不能影响索引本身
        console.warn(`[index] 变化通知失败：${(err as Error).message}`);
      }
    }
  }

  /**
   * 自己写入文件时先登记。watcher 在时间窗内看到该路径时，读一下文件和索引比内容：
   * 一样（就是自己刚写的）才跳过；不一样说明外部恰好在这时改了它，照常索引。
   * 以前时间窗内一律跳过，外部在保存后 0.8 秒内的修改会丢（CI 上偶发）。
   */
  ignoreNext(relPath: string): void {
    this.ignored.set(relPath, Date.now() + SELF_WRITE_WINDOW_MS);
    setTimeout(() => {
      const until = this.ignored.get(relPath);
      if (until !== undefined && until <= Date.now()) this.ignored.delete(relPath);
    }, SELF_WRITE_WINDOW_MS + 50).unref?.();
  }

  /** 磁盘上的这篇和索引里记的内容一样（hash 相同） */
  private matchesIndex(relPath: string): boolean {
    if (!fs.existsSync(this.store.absPath(relPath))) return false;
    const row = this.db.prepare("SELECT content_hash AS hash FROM notes WHERE path = ?").get(relPath) as
      | { hash: string }
      | undefined;
    return row !== undefined && this.store.read(relPath).hash === row.hash;
  }

  private isSelfWrite(relPath: string): boolean {
    const until = this.ignored.get(relPath);
    if (until === undefined) return false;
    if (Date.now() <= until) return true;
    this.ignored.delete(relPath);
    return false;
  }

  /**
   * 两个文件可能共用同一个 frontmatter id（Explorer 里复制 .md 就会发生）。
   * 索引按「路径优先」：后出现的那个改用从路径派生的稳定 id，两条笔记都留在索引里。
   */
  private uniqueId(candidate: string, relPath: string): string {
    const row = this.db.prepare("SELECT path FROM notes WHERE id = ?").get(candidate) as
      | { path: string }
      | undefined;
    if (!row || row.path === relPath) return candidate;
    const derived = `${candidate}-${contentHash(relPath).slice(0, 6)}`;
    console.warn(`[index] id 冲突：${relPath} 与 ${row.path} 共用 id ${candidate}，前者索引为 ${derived}`);
    return derived;
  }

  /** 索引一个文件；文件已不存在时从索引移除并返回 null */
  indexFile(relPath: string): IndexResult | null {
    if (!fs.existsSync(this.store.absPath(relPath))) {
      this.removeFile(relPath);
      return null;
    }
    const note = this.store.read(relPath);
    const at = toLocalIso(this.now());

    const previous = this.db.prepare("SELECT id FROM notes WHERE path = ?").get(relPath) as
      | { id: string }
      | undefined;
    const before = previous ? this.indexedShape(previous.id) : null;
    const cardsBefore = previous ? this.cardsOf(previous.id) : [];
    if (previous) this.deleteById(previous.id);
    const id = this.uniqueId(note.id, relPath);

    const tags = new Set<string>([...note.parsed.meta.tags, ...extractTags(note.parsed.body)]);
    const links = extractLinks(note.parsed.body);
    const summary = excerpt(note.parsed.body, 160);

    this.db
      .prepare(
        `INSERT OR REPLACE INTO notes (id, path, title, excerpt, type, created, updated, content_hash, chars, indexed_at, group_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        relPath,
        note.parsed.meta.title,
        summary,
        note.parsed.meta.type,
        note.parsed.meta.created,
        note.parsed.meta.updated,
        note.hash,
        note.parsed.body.length,
        at,
        note.parsed.meta.group ?? null,
      );

    const insertTag = this.db.prepare("INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?, ?)");
    for (const tag of tags) insertTag.run(id, tag);

    const insertLink = this.db.prepare(
      "INSERT INTO links (src_id, target_title, target_id) VALUES (?, ?, ?)",
    );
    for (const link of links) {
      insertLink.run(id, link.title, this.resolveTargetId(link.title));
    }

    // 全文行的 rowid 和 notes 行的 rowid 对齐：删改都按 rowid 定位（note_id 是 UNINDEXED 列，按它查会扫整张表）
    const { rowid } = this.db.prepare("SELECT rowid FROM notes WHERE id = ?").get(id) as { rowid: number };
    this.db.prepare("DELETE FROM notes_fts WHERE rowid = ?").run(rowid);
    this.db
      .prepare("INSERT INTO notes_fts (rowid, note_id, title, body) VALUES (?, ?, ?, ?)")
      .run(rowid, id, note.parsed.meta.title, note.parsed.body);

    // 知识简卡（srs-001）
    const cards = indexCards(id, parseCards(note.parsed.body));
    const insertCard = this.db.prepare(
      "INSERT OR REPLACE INTO cards (id, note_id, ord, kind, title, body, line) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const card of cards) insertCard.run(card.id, id, card.ord, card.kind, card.title, card.body, card.line);
    if (this.cardRenamed && cardsBefore.length > 0) {
      for (const [newId, oldId] of matchRenamed(cardsBefore, cards)) this.cardRenamed(newId, oldId);
    }

    // 之前引用过我标题的笔记，现在可以补上 target_id 了
    this.db
      .prepare("UPDATE links SET target_id = ? WHERE target_title = ? AND target_id IS NULL")
      .run(id, note.parsed.meta.title);

    this.emit({ kind: "changed", id, path: relPath, hash: note.hash });

    const after: IndexedShape = {
      title: note.parsed.meta.title,
      type: note.parsed.meta.type,
      group: note.parsed.meta.group ?? null,
      tags: [...tags],
      links: links.map((link) => link.title),
    };
    return { id, hash: note.hash, excerpt: summary, tags: [...tags], changes: diffIndexed(before, after) };
  }

  private indexedShape(id: string): IndexedShape | null {
    const row = this.db.prepare("SELECT title, type, group_name FROM notes WHERE id = ?").get(id) as
      | { title: string; type: string; group_name: string | null }
      | undefined;
    if (!row) return null;
    const tags = (this.db.prepare("SELECT tag FROM tags WHERE note_id = ?").all(id) as Array<{ tag: string }>).map(
      (r) => r.tag,
    );
    const links = (
      this.db.prepare("SELECT target_title FROM links WHERE src_id = ?").all(id) as Array<{ target_title: string }>
    ).map((r) => r.target_title);
    return { title: row.title, type: row.type, group: row.group_name, tags, links };
  }

  removeFile(relPath: string): void {
    const row = this.db.prepare("SELECT id FROM notes WHERE path = ?").get(relPath) as
      | { id: string }
      | undefined;
    if (!row) return;
    this.deleteById(row.id);
    this.emit({ kind: "removed", id: row.id, path: relPath });
  }

  private deleteById(id: string): void {
    // 先按 rowid 删全文行（必须在删 notes 行之前取 rowid）
    const row = this.db.prepare("SELECT rowid FROM notes WHERE id = ?").get(id) as { rowid: number } | undefined;
    if (row) this.db.prepare("DELETE FROM notes_fts WHERE rowid = ? AND note_id = ?").run(row.rowid, id);
    this.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM tags WHERE note_id = ?").run(id);
    this.db.prepare("DELETE FROM links WHERE src_id = ?").run(id);
    this.db.prepare("DELETE FROM cards WHERE note_id = ?").run(id);
    this.db.prepare("UPDATE links SET target_id = NULL WHERE target_id = ?").run(id);
  }

  private resolveTargetId(title: string): string | null {
    const row = this.db
      .prepare("SELECT id FROM notes WHERE title = ? ORDER BY path LIMIT 1")
      .get(title) as { id: string } | undefined;
    return row ? row.id : null;
  }

  /**
   * 启动时把索引和磁盘对齐（perf-006）：
   * - 内容 hash 和索引里一样的文件直接跳过（平时启动绝大多数文件都没变）；
   * - 变了的、新的重新索引，磁盘上没有了的移除；
   * - 每 REINDEX_BATCH 篇一个事务，免得每写一行就落一次盘。
   * 索引里的数据只由文件内容决定，所以跳过没变的文件结果不变。
   * force：左栏「重建索引」按钮用，不管有没有变都重写一遍（怀疑索引不对时的兜底）。
   */
  reindexAll(opts: { force?: boolean } = {}): { indexed: number; unchanged: number; removed: number; failed: number } {
    const files = this.store.list();
    const known = new Map(
      (this.db.prepare("SELECT path, content_hash AS hash FROM notes").all() as Array<{ path: string; hash: string }>).map(
        (r) => [r.path, r.hash],
      ),
    );
    let indexed = 0;
    let unchanged = 0;
    let removed = 0;
    let failed = 0;
    let inBatch = 0;
    this.muted += 1;
    this.db.exec("BEGIN");
    const commitEvery = () => {
      inBatch += 1;
      if (inBatch >= REINDEX_BATCH) {
        this.db.exec("COMMIT");
        this.db.exec("BEGIN");
        inBatch = 0;
      }
    };
    try {
      for (const relPath of files) {
        const indexedHash = known.get(relPath);
        known.delete(relPath);
        try {
          if (!opts.force && indexedHash !== undefined && indexedHash === contentHash(fs.readFileSync(this.store.absPath(relPath), "utf8"))) {
            unchanged += 1;
            continue;
          }
          this.indexFile(relPath);
          indexed += 1;
          commitEvery();
        } catch (err) {
          // 单个文件坏掉（编码异常、被别的程序锁住、同名目录）不该拖垮整次启动
          failed += 1;
          console.warn(`[index] 跳过无法索引的文件 ${relPath}：${(err as Error).message}`);
        }
      }
      for (const stale of known.keys()) {
        this.removeFile(stale);
        removed += 1;
        commitEvery();
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.muted -= 1;
    }
    this.emit({ kind: "resync" });
    return { indexed, unchanged, removed, failed };
  }

  watch(): () => void {
    const timers = new Map<string, NodeJS.Timeout>();
    const watcher = fs.watch(this.store.notesRoot, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = String(filename).split(path.sep).join("/").split("\\").join("/");
      if (!rel.toLowerCase().endsWith(".md")) return;
      const selfWrite = this.isSelfWrite(rel);
      const pending = timers.get(rel);
      if (pending) clearTimeout(pending);
      timers.set(
        rel,
        setTimeout(() => {
          timers.delete(rel);
          try {
            if (selfWrite && this.matchesIndex(rel)) return;
            this.indexFile(rel);
          } catch {
            // 文件在防抖窗口内被删掉了；下次扫描会纠正
          }
        }, DEBOUNCE_MS),
      );
    });
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      watcher.close();
    };
  }
}

export type { StoredNote };
