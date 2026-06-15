export interface FileRecord {
  id: number;
  path: string;
  title: string | null;
  tags: string | null;       // JSON array
  frontmatter: string | null; // JSON object
  mtime_ms: number;
  chunk_count: number;
}

export interface ChunkRecord {
  id: number;
  file_id: number;
  chunk_index: number;
  heading: string | null;
  content: string;
  token_count: number | null;
  embedding: Buffer | null;
}

export interface SearchResult {
  filePath: string;
  title: string;
  tags: string[];
  heading: string | null;
  snippet: string;
  score: number;
  scores: { bm25?: number; vector?: number };
}

export interface IndexStats {
  fileCount: number;
  chunkCount: number;
  embeddedCount: number;
  dbSizeBytes: number;
}

export interface ProgressCallback {
  (phase: string, current: number, total: number, detail?: string): void;
}

export interface Chunk {
  chunkIndex: number;
  heading: string | null;
  content: string;
  tokenCount: number;
}

export interface ParsedFile {
  path: string;
  title: string | null;
  tags: string[];
  frontmatter: Record<string, any>;
  chunks: Chunk[];
  mtime_ms: number;
}
