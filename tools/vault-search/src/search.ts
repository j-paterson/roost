import { getDb } from "./db";
import { embedText, vecToBuffer } from "./embedder";
import type { SearchResult } from "./types";
import fs from "fs";
import path from "path";
import { VAULT_PATH } from "./config";

const RRF_K = 60;

/**
 * Sanitize user input for FTS5 MATCH. Strips characters that have special
 * meaning in FTS5 query syntax (operators, column filters, NEAR, prefix
 * wildcards) so a natural-language query like "cross-chain bridges" can't
 * accidentally be parsed as `cross NOT chain:bridges` (which surfaces as
 * `no such column: chain` and similar parse errors).
 */
export function sanitizeFtsQuery(query: string): string {
  // Replace FTS5 special chars with spaces.
  // - * " ^ ( ) [ ] { } : are syntax
  // - - + ! are query operators (NOT, AND, NEGATION)
  // - / ~ \ : column / regex / escapes
  let q = query.replace(/[*"^(){}\[\]:\-+!\\/~]/g, " ");
  // Remove standalone FTS5 boolean operators (case-sensitive per spec)
  q = q.replace(/\b(AND|OR|NOT|NEAR)\b/g, " ");
  // Collapse whitespace, trim
  q = q.replace(/\s+/g, " ").trim();
  return q;
}

/** Hybrid BM25 + vector search with Reciprocal Rank Fusion */
export async function searchVault(
  query: string,
  opts: { limit?: number } = {},
): Promise<SearchResult[]> {
  const limit = opts.limit || 10;
  const db = getDb();

  // BM25 search via FTS5 — sanitize before MATCH to avoid syntax errors on
  // user-typed punctuation (issue #4 surfaced "cross-chain" as `cross NOT chain`).
  const ftsQuery = sanitizeFtsQuery(query);
  const ftsResults = ftsQuery ? (db.prepare(`
    SELECT rowid, rank
    FROM chunks_fts
    WHERE chunks_fts MATCH ?
    ORDER BY rank
    LIMIT 50
  `).all(ftsQuery) as { rowid: number; rank: number }[]) : [];

  // Vector search — embed query then KNN
  let vecResults: { rowid: number; distance: number }[] = [];
  try {
    const queryVec = await embedText(query);
    const queryBuf = vecToBuffer(queryVec);
    vecResults = db.prepare(`
      SELECT rowid, distance
      FROM chunks_vec
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT 50
    `).all(queryBuf) as { rowid: number; distance: number }[];
  } catch {
    // Ollama might not be running — fall back to BM25 only
  }

  // RRF fusion
  const scores = new Map<number, { bm25?: number; vector?: number; rrfScore: number }>();

  for (let i = 0; i < ftsResults.length; i++) {
    const id = ftsResults[i].rowid;
    const entry = scores.get(id) || { rrfScore: 0 };
    entry.bm25 = ftsResults[i].rank;
    entry.rrfScore += 1 / (RRF_K + i + 1);
    scores.set(id, entry);
  }

  for (let i = 0; i < vecResults.length; i++) {
    const id = vecResults[i].rowid;
    const entry = scores.get(id) || { rrfScore: 0 };
    entry.vector = vecResults[i].distance;
    entry.rrfScore += 1 / (RRF_K + i + 1);
    scores.set(id, entry);
  }

  // Sort by RRF score
  const ranked = [...scores.entries()]
    .sort((a, b) => b[1].rrfScore - a[1].rrfScore)
    .slice(0, limit);

  if (ranked.length === 0) return [];

  // Fetch chunk + file details
  const results: SearchResult[] = [];
  const getChunkInfo = db.prepare(`
    SELECT c.content, c.heading, f.path, f.title, f.tags
    FROM chunks c
    JOIN files f ON c.file_id = f.id
    WHERE c.id = ?
  `);

  // Deduplicate by file (keep highest-scoring chunk per file)
  const seenFiles = new Set<string>();

  for (const [chunkId, scoreInfo] of ranked) {
    const row = getChunkInfo.get(chunkId) as {
      content: string; heading: string | null;
      path: string; title: string | null; tags: string | null;
    } | undefined;

    if (!row || seenFiles.has(row.path)) continue;
    seenFiles.add(row.path);

    // Create snippet (first 200 chars of chunk)
    let snippet = row.content;
    // Strip context prefix
    if (snippet.startsWith("Title:")) {
      const nlIdx = snippet.indexOf("\n\n");
      if (nlIdx > 0) snippet = snippet.slice(nlIdx + 2);
    }
    snippet = snippet.slice(0, 200).trim();
    if (snippet.length < row.content.length) snippet += "...";

    let tags: string[] = [];
    try { tags = JSON.parse(row.tags || "[]"); } catch {}

    results.push({
      filePath: row.path,
      title: row.title || path.basename(row.path, ".md"),
      tags,
      heading: row.heading,
      snippet,
      score: scoreInfo.rrfScore,
      scores: { bm25: scoreInfo.bm25, vector: scoreInfo.vector },
    });
  }

  return results;
}

/** Find notes similar to a given note */
export async function findSimilar(
  filePath: string,
  opts: { limit?: number } = {},
): Promise<SearchResult[]> {
  const limit = opts.limit || 10;
  const db = getDb();

  // Get all chunk embeddings for this file
  const fileChunks = db.prepare(`
    SELECT cv.rowid, cv.embedding
    FROM chunks_vec cv
    JOIN chunks c ON cv.rowid = c.id
    JOIN files f ON c.file_id = f.id
    WHERE f.path = ?
  `).all(filePath) as { rowid: number; embedding: Buffer }[];

  if (fileChunks.length === 0) return [];

  // Compute centroid
  const dim = fileChunks[0].embedding.length / 4;
  const centroid = new Float32Array(dim);
  for (const chunk of fileChunks) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += chunk.embedding.readFloatLE(i * 4);
    }
  }
  for (let i = 0; i < dim; i++) {
    centroid[i] /= fileChunks.length;
  }

  const centroidBuf = Buffer.alloc(dim * 4);
  for (let i = 0; i < dim; i++) {
    centroidBuf.writeFloatLE(centroid[i], i * 4);
  }

  // KNN against centroid
  const vecResults = db.prepare(`
    SELECT rowid, distance
    FROM chunks_vec
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `).all(centroidBuf, limit + 20) as { rowid: number; distance: number }[];

  // Get file paths for results, exclude source file
  const getChunkInfo = db.prepare(`
    SELECT c.content, c.heading, f.path, f.title, f.tags
    FROM chunks c JOIN files f ON c.file_id = f.id WHERE c.id = ?
  `);

  const results: SearchResult[] = [];
  const seenFiles = new Set<string>();
  seenFiles.add(filePath);

  for (const vr of vecResults) {
    const row = getChunkInfo.get(vr.rowid) as any;
    if (!row || seenFiles.has(row.path)) continue;
    seenFiles.add(row.path);

    let snippet = row.content;
    if (snippet.startsWith("Title:")) {
      const nlIdx = snippet.indexOf("\n\n");
      if (nlIdx > 0) snippet = snippet.slice(nlIdx + 2);
    }
    snippet = snippet.slice(0, 200).trim();

    let tags: string[] = [];
    try { tags = JSON.parse(row.tags || "[]"); } catch {}

    results.push({
      filePath: row.path,
      title: row.title || path.basename(row.path, ".md"),
      tags,
      heading: row.heading,
      snippet,
      score: 1 / (1 + vr.distance), // convert distance to similarity
      scores: { vector: vr.distance },
    });

    if (results.length >= limit) break;
  }

  return results;
}

/** Get full file content + frontmatter */
export function getContext(filePath: string): { content: string; frontmatter: Record<string, any> } | null {
  const db = getDb();
  const row = db.prepare("SELECT frontmatter FROM files WHERE path = ?").get(filePath) as { frontmatter: string } | undefined;

  const fullPath = path.join(VAULT_PATH, filePath);
  if (!fs.existsSync(fullPath)) return null;

  const content = fs.readFileSync(fullPath, "utf-8");
  let frontmatter: Record<string, any> = {};
  try { frontmatter = JSON.parse(row?.frontmatter || "{}"); } catch {}

  return { content, frontmatter };
}
