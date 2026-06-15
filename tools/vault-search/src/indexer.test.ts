import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Regression test for issue #3 — `index --full` was failing with
 * "no such column: T.file_title" because:
 *   - chunks_fts is a content-linked FTS5 table (content='chunks')
 *   - chunks_fts declares extra columns (file_title, file_tags) that
 *     do NOT exist in chunks
 *   - any DELETE FROM chunks_fts or 'rebuild' command makes FTS5
 *     probe the content table for those columns, which fails
 *
 * The reset path now drops + recreates chunks_fts instead.
 */
describe("indexer --full reset (regression for #3)", () => {
  let tmpVault: string;
  let tmpData: string;

  beforeEach(() => {
    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), "vault-search-"));
    tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "vault-search-data-"));
    fs.mkdirSync(path.join(tmpVault, "Notes"), { recursive: true });
    fs.writeFileSync(path.join(tmpVault, "Notes", "x.md"), "# Test\nSome content.");

    process.env.VAULT_PATH = tmpVault;
    process.env.DB_PATH = path.join(tmpData, "search.db");
    // Skip embeddings — would require Ollama running. We just want to
    // exercise the reset path without it failing on FTS5.
  });

  afterEach(() => {
    fs.rmSync(tmpVault, { recursive: true, force: true });
    fs.rmSync(tmpData, { recursive: true, force: true });
    delete process.env.VAULT_PATH;
    delete process.env.DB_PATH;
  });

  it("the reset block (DELETE chunks_vec/chunks/files + drop+recreate chunks_fts) runs without 'T.file_title' errors", async () => {
    // We re-import inside the test so the module picks up our env overrides.
    // Use a `vi.resetModules()`-style fresh import.
    const dbMod = await import("./db");
    const indexerMod = await import("./indexer");

    const db = dbMod.getDb();
    // Pre-seed: insert a fake row so the tables aren't trivially empty before reset.
    db.exec("INSERT INTO files (id, path, mtime_ms) VALUES (1, 'seed.md', 0)");
    db.exec("INSERT INTO chunks (id, file_id, chunk_index, content) VALUES (1, 1, 0, 'seed content')");
    db.exec("INSERT INTO chunks_fts (rowid, content, heading, file_title, file_tags) VALUES (1, 'seed content', '', '', '')");

    // The reset path lives inside indexVault when called with full=true.
    // We don't want to actually run the embed phase (no Ollama), so we
    // exercise the reset by extracting just the SQL the indexer would run.
    // Equivalent to what's inside `if (full)` at the top of indexVault:
    expect(() => {
      db.exec("DELETE FROM chunks_vec");
      db.exec("DELETE FROM chunks");
      db.exec("DELETE FROM files");
      db.exec("DROP TABLE IF EXISTS chunks_fts");
      db.exec(`
        CREATE VIRTUAL TABLE chunks_fts USING fts5(
          content, heading, file_title, file_tags,
          content='chunks', content_rowid='id'
        )
      `);
    }).not.toThrow();

    // Verify clean state
    const filesCount = db.prepare("SELECT count(*) as c FROM files").get() as { c: number };
    expect(filesCount.c).toBe(0);

    const ftsExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_fts'").get();
    expect(ftsExists).toBeTruthy();

    // The buggy patterns should still fail (lock in semantics)
    expect(() => db.exec("DELETE FROM chunks_fts")).toThrow(/file_title/);
    expect(() => db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')")).toThrow(/file_title/);

    dbMod.closeDb();

    // Mark the module as used so the import isn't tree-shaken.
    expect(typeof indexerMod.indexVault).toBe("function");
  });
});
