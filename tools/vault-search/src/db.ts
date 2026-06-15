import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import fs from "fs";
import path from "path";
import { DB_PATH, EMBED_DIMS } from "./config";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  // Ensure the DB's parent directory exists (NOT the legacy $VAULT/.vault-search,
  // which fails when VAULT is a read-only mount and the DB lives elsewhere via env).
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Load sqlite-vec extension
  sqliteVec.load(db);

  // Create schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      title TEXT,
      tags TEXT,
      frontmatter TEXT,
      mtime_ms INTEGER NOT NULL,
      chunk_count INTEGER DEFAULT 0,
      indexed_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      heading TEXT,
      content TEXT NOT NULL,
      token_count INTEGER,
      UNIQUE(file_id, chunk_index)
    );

    CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
    CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
  `);

  // FTS5 table — check if exists first
  const ftsExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_fts'").get();
  if (!ftsExists) {
    db.exec(`
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        content,
        heading,
        file_title,
        file_tags,
        content='chunks',
        content_rowid='id'
      );
    `);
  }

  // sqlite-vec table
  const vecExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_vec'").get();
  if (!vecExists) {
    db.exec(`CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[${EMBED_DIMS}])`);
  }

  _db = db;
  return db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
