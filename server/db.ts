import { DatabaseSync } from "node:sqlite";

/**
 * 改了表结构或索引里的派生字段（摘要、类型）就加一，旧库打开时整库重建。
 * 3：list-001 摘要规则、ui-008 inbox/ 默认算想法；4：notes_fts 的 rowid 与 notes 对齐（perf-006）；5：知识简卡表 cards（srs-001）；
 * 6：notes.template 列、全文索引不含 HTML 注释（tpl-001）
 */
export const SCHEMA_VERSION = 6;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  title TEXT,
  excerpt TEXT,
  type TEXT,
  created TEXT,
  updated TEXT,
  content_hash TEXT,
  chars INTEGER,
  indexed_at TEXT,
  group_name TEXT,
  template TEXT
);
CREATE INDEX IF NOT EXISTS notes_updated ON notes(updated DESC);
CREATE INDEX IF NOT EXISTS notes_title ON notes(title);
CREATE INDEX IF NOT EXISTS notes_group ON notes(group_name);

CREATE TABLE IF NOT EXISTS tags (
  note_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);
CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);

CREATE TABLE IF NOT EXISTS links (
  src_id TEXT NOT NULL,
  target_title TEXT NOT NULL,
  target_id TEXT
);
CREATE INDEX IF NOT EXISTS links_src ON links(src_id);
CREATE INDEX IF NOT EXISTS links_target ON links(target_id);
CREATE INDEX IF NOT EXISTS links_title ON links(target_title);

-- 知识简卡（srs-001）：从笔记正文解析出来的卡片，可重建；复习状态不在这里（在 data/review/log.jsonl）
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_note ON cards(note_id);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  note_id UNINDEXED,
  title,
  body,
  tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT,
  mode TEXT,
  model TEXT,
  created TEXT,
  output TEXT,
  inserted INTEGER NOT NULL DEFAULT 0
);
`;

const ALL_TABLES = ["notes_fts", "cards", "links", "tags", "notes", "ai_calls", "meta"];

/** 打开（或创建）索引库。索引是可重建的派生数据：schema 版本对不上就整库重建。 */
export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");

  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (row && row.value !== String(SCHEMA_VERSION)) {
    for (const table of ALL_TABLES) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
  }

  db.exec(SCHEMA);
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(
    String(SCHEMA_VERSION),
  );
  return db;
}
