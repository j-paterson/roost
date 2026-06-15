import fs from "fs";
import { VAULT_PATH } from "./config";
import { indexVault } from "./indexer";
import { isExcluded } from "./scanner";

const DEBOUNCE_MS = 2000;

let pendingPaths = new Set<string>();
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let indexing = false;

async function flush() {
  if (indexing || pendingPaths.size === 0) return;
  indexing = true;
  const count = pendingPaths.size;
  pendingPaths.clear();

  try {
    console.error(`[watch] ${count} change(s) detected, running incremental index...`);
    const stats = await indexVault((phase, cur, total, detail) => {
      if (phase === "done") console.error(`[watch] ✓ ${detail}`);
    });
    console.error(`[watch] Index updated: ${stats.fileCount} files, ${stats.chunkCount} chunks, ${stats.embeddedCount} embedded`);
  } catch (err: any) {
    console.error(`[watch] Index error: ${err.message}`);
  }

  indexing = false;

  // If more changes arrived during indexing, flush again
  if (pendingPaths.size > 0) {
    flush();
  }
}

export function startWatcher(vaultPath = VAULT_PATH): fs.FSWatcher {
  console.error(`[watch] Watching ${vaultPath} for .md changes (${DEBOUNCE_MS}ms debounce)`);

  const watcher = fs.watch(vaultPath, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    if (!filename.endsWith(".md")) return;
    if (isExcluded(filename)) return;

    pendingPaths.add(filename);

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, DEBOUNCE_MS);
  });

  watcher.on("error", (err) => {
    console.error(`[watch] Watcher error: ${err.message}`);
  });

  return watcher;
}
