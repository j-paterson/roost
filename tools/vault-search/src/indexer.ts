import Database from "better-sqlite3";
import { getDb } from "./db";
import { scanVault } from "./scanner";
import { chunkFile } from "./chunker";
import { embedAll, vecToBuffer } from "./embedder";
import type { ProgressCallback, IndexStats } from "./types";

export async function indexVault(
  onProgress?: ProgressCallback,
  full = false,
): Promise<IndexStats> {
  const db = getDb();

  if (full) {
    onProgress?.("reset", 0, 0, "Clearing existing index...");
    db.exec("DELETE FROM chunks_vec");
    db.exec("DELETE FROM chunks");
    db.exec("DELETE FROM files");
    // chunks_fts is a content-linked FTS5 table (content='chunks') but
    // declares extra columns (file_title, file_tags) that don't exist in
    // chunks. Both `DELETE FROM chunks_fts` and `... VALUES('rebuild')`
    // fail with "no such column: T.file_title" because FTS5 probes the
    // content table for all declared columns. Drop + recreate is the
    // cleanest reset that doesn't require schema migration.
    db.exec("DROP TABLE IF EXISTS chunks_fts");
    db.exec(`
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        content,
        heading,
        file_title,
        file_tags,
        content='chunks',
        content_rowid='id'
      )
    `);
  }

  // Phase 1: Scan for changes
  onProgress?.("scan", 0, 0, "Scanning vault...");
  const { changed, deleted } = scanVault(db);
  onProgress?.("scan", 1, 1, `${changed.length} changed, ${deleted.length} deleted`);

  // Phase 2: Remove deleted files
  if (deleted.length > 0) {
    const deleteFile = db.prepare("DELETE FROM files WHERE path = ?");
    const deleteTx = db.transaction((paths: string[]) => {
      for (const p of paths) deleteFile.run(p);
    });
    deleteTx(deleted);
    onProgress?.("delete", deleted.length, deleted.length);
  }

  // Phase 3: Chunk changed files
  if (changed.length > 0) {
    onProgress?.("chunk", 0, changed.length, "Chunking files...");

    const upsertFile = db.prepare(`
      INSERT INTO files (path, title, tags, frontmatter, mtime_ms, chunk_count)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        title = excluded.title,
        tags = excluded.tags,
        frontmatter = excluded.frontmatter,
        mtime_ms = excluded.mtime_ms,
        chunk_count = excluded.chunk_count,
        indexed_at = datetime('now')
    `);

    const deleteChunks = db.prepare("DELETE FROM chunks WHERE file_id = (SELECT id FROM files WHERE path = ?)");
    const insertChunk = db.prepare(`
      INSERT INTO chunks (file_id, chunk_index, heading, content, token_count)
      VALUES ((SELECT id FROM files WHERE path = ?), ?, ?, ?, ?)
    `);

    // FTS5 sync triggers
    const insertFts = db.prepare(`
      INSERT INTO chunks_fts (rowid, content, heading, file_title, file_tags)
      VALUES (?, ?, ?, ?, ?)
    `);
    const deleteFts = db.prepare("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE file_id = (SELECT id FROM files WHERE path = ?))");

    const chunkTx = db.transaction((files: typeof changed) => {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        try {
          const parsed = chunkFile(f.path);

          // Delete old FTS entries before chunks
          deleteFts.run(f.path);
          // Delete old chunks
          deleteChunks.run(f.path);

          // Upsert file
          upsertFile.run(
            f.path,
            parsed.title,
            JSON.stringify(parsed.tags),
            JSON.stringify(parsed.frontmatter),
            f.mtime_ms,
            parsed.chunks.length,
          );

          // Insert new chunks
          for (const chunk of parsed.chunks) {
            insertChunk.run(f.path, chunk.chunkIndex, chunk.heading, chunk.content, chunk.tokenCount);
          }

          // Get chunk IDs for FTS
          const chunkRows = db.prepare(
            "SELECT id, content, heading FROM chunks WHERE file_id = (SELECT id FROM files WHERE path = ?)"
          ).all(f.path) as { id: number; content: string; heading: string | null }[];

          for (const row of chunkRows) {
            insertFts.run(row.id, row.content, row.heading || "", parsed.title || "", parsed.tags.join(", "));
          }
        } catch (err: any) {
          // Skip files that fail to parse
          console.error(`Failed to chunk ${f.path}: ${err.message}`);
        }

        if (i % 100 === 0) {
          onProgress?.("chunk", i, files.length, f.path);
        }
      }
    });

    chunkTx(changed);
    onProgress?.("chunk", changed.length, changed.length);
  }

  // Phase 4: Embed chunks without embeddings
  const unembedded = db.prepare(
    "SELECT c.id, c.content FROM chunks c WHERE c.id NOT IN (SELECT rowid FROM chunks_vec)"
  ).all() as { id: number; content: string }[];

  if (unembedded.length > 0) {
    onProgress?.("embed", 0, unembedded.length, "Embedding chunks...");

    const texts = unembedded.map(c => c.content);
    const embeddings = await embedAll(texts, (done, total) => {
      onProgress?.("embed", done, total);
    });

    // Store embeddings in sqlite-vec
    const insertVec = db.prepare("INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)");
    const vecTx = db.transaction(() => {
      for (let i = 0; i < unembedded.length; i++) {
        if (embeddings[i]) {
          try {
            insertVec.run(BigInt(unembedded[i].id), vecToBuffer(embeddings[i]));
          } catch (e: any) {
            if (!e.message.includes("UNIQUE")) {
              console.error(`Vec insert failed for chunk ${unembedded[i].id}: ${e.message}`);
            }
          }
        }
      }
    });
    vecTx();

    onProgress?.("embed", unembedded.length, unembedded.length);
  }

  // Return stats
  const stats = getStats(db);
  onProgress?.("done", 0, 0, `${stats.fileCount} files, ${stats.chunkCount} chunks, ${stats.embeddedCount} embedded`);
  return stats;
}

export function getStats(db?: Database.Database): IndexStats {
  const d = db || getDb();
  const fileCount = (d.prepare("SELECT COUNT(*) as c FROM files").get() as any).c;
  const chunkCount = (d.prepare("SELECT COUNT(*) as c FROM chunks").get() as any).c;
  const embeddedCount = (d.prepare("SELECT COUNT(*) as c FROM chunks_vec").get() as any).c;

  const { DB_PATH } = require("./config");
  const fs = require("fs");
  let dbSizeBytes = 0;
  try { dbSizeBytes = fs.statSync(DB_PATH).size; } catch {}

  return { fileCount, chunkCount, embeddedCount, dbSizeBytes };
}
