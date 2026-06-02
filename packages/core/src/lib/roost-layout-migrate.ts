/**
 * One-time migration: move legacy flat .roost/* files into .roost/cache and .roost/build.
 */
import * as fs from "fs";
import * as nodePath from "path";

const CACHE_FILES = [
  "embedding-cache.json", "embedding-vectors.bin", "clip-vectors.bin",
  "anchor-name-embeddings.json", "article-fetch-cache.json", "category-embeddings.json",
  "collection-descriptions-contrastive.json", "collection-not-descriptions.json",
  "deleted-ids.json", "digest-cache.json",
  "recipe-cache.json", "places-cache.json", "places-cache.version",
  "media-cache.json", "media-fetch-cache.json",
  "products-cache.json", "workouts-cache.json", "tutorials-cache.json", "home-cache.json",
  "nominatim-cache.json",
  "roost-memory-cache.json", "score-cache.json", "thread-fetch-cache.json",
];

const BUILD_ITEMS = [
  "venv", "nomic-finetuned-hardneg", "nomic-finetuned", "nomic-finetuned-noprefix",
  "strategy-results.json", "strategy-results-v2.json", "llm-rerank-results.json",
  "embedding-cache-finetuned.json", "embedding-cache-finetuned-noprefix.json",
  "embedding-cache-hardneg.json", "embedding-cache-nomic-raw.json",
  "embedding-cache-hf-baseline.json", "embedding-cache-hf-baseline-noprefix.json",
  "t1-rotation-results.json", "cross-encoder-results.json", "classifier-head-results.json",
];

export function migrateRoostLayout(vaultRoot: string): void {
  const root = nodePath.join(vaultRoot, ".roost");
  if (!fs.existsSync(root)) return;
  const cacheDir = nodePath.join(root, "cache");
  const buildDir = nodePath.join(root, "build");
  const alreadyMigrated = fs.existsSync(cacheDir) || fs.existsSync(buildDir);

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(buildDir, { recursive: true });

  if (alreadyMigrated) return;

  let moved = 0;
  const move = (name: string, destDir: string) => {
    const src = nodePath.join(root, name);
    if (!fs.existsSync(src)) return;
    const dst = nodePath.join(destDir, name);
    if (fs.existsSync(dst)) return;
    try { fs.renameSync(src, dst); moved++; }
    catch (e) { console.warn(`[roost] migration: failed to move ${name}:`, e); }
  };
  for (const f of CACHE_FILES) move(f, cacheDir);
  for (const f of BUILD_ITEMS) move(f, buildDir);

  if (moved > 0) console.log(`[roost] migrated ${moved} files into .roost/{cache,build}/`);
}
