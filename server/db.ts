import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 2;

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
  group_name TEXT
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

const ALL_TABLES = ["notes_fts", "links", "tags", "notes", "ai_calls", "meta"];

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
