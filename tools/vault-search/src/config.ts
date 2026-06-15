import path from "path";

export const VAULT_PATH = process.env.VAULT_PATH || path.join(process.env.HOME || "", "ObsidianVault");
export const DB_DIR = ".vault-search";
export const DB_NAME = "search.db";
export const DB_PATH = process.env.DB_PATH || path.join(VAULT_PATH, DB_DIR, DB_NAME);

export const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
export const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";
export const EMBED_DIMS = 768;
export const EMBED_BATCH_SIZE = 15;
export const EMBED_CONCURRENCY = 5;

export const CHUNK_TARGET_TOKENS = 512;
export const CHUNK_OVERLAP_TOKENS = 50;
export const CHARS_PER_TOKEN = 4; // approximate

export const EXCLUDE_DIRS = new Set([
  "Archive",
  "templates",
  ".obsidian",
  ".git",
  ".claude",
  ".roost",
  ".vault-search",
  "assets",
  "node_modules",
  // ObsidianBookmarks-specific: these subdirs are low-signal or working state.
  "People",        // 11,971 stubs (just `handle: @foo` + a header) — no semantic content
  "Pipelines",     // Roost pipeline state
  "_embed-job",    // local working dir for embedding jobs
  ".SynologyWorkingDirectory",  // Synology Drive sync metadata
]);
