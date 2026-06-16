/**
 * One-shot recovery migration: reads `recipe-cache.json` and
 * `workouts-cache.json` and writes back the correct string[] values
 * for `recipe_ingredients` and `workout_exercises` on any note whose
 * frontmatter copy is corrupt ("[object Object]") or absent.
 *
 * The caches on disk still hold the OLD object shape
 * (`{item, qty}[]` / `{name, reps}[]`) because that's what the
 * extractor wrote before the P0.1/P0.2 field-type fix.  This function
 * reformats them to strings and patches the note frontmatter, leaving
 * all other fields untouched.
 *
 * SAFE TO RUN MULTIPLE TIMES — the no-op guard prevents re-writes.
 * DO NOT execute against a real vault during tests.
 */
import * as fs from "fs";
import type { TFile } from "obsidian";
import type { IRoostPlugin } from "@/types/plugin";
import { updateNoteFrontmatter } from "@/lib/vault-helpers";
import { loadPipelineCache } from "@/pipeline/shared";
import { vaultBasePath } from "@/lib/vault-utils";
import { cachePath, cacheDir } from "@/lib/roost-paths";

// ── Result type ───────────────────────────────────────────────────────────────

export interface RecoverResult {
  recipesFixed: number;
  workoutsFixed: number;
}

// ── Format helpers ────────────────────────────────────────────────────────────

/**
 * Format one ingredient element — handles BOTH old object shape and new
 * string shape so re-running is safe.
 *   Old: { item: string; qty: string | null }
 *   New: string
 */
function formatIngredient(el: unknown): string {
  if (typeof el === "string") return el.trim();
  const obj = el as { item?: unknown; qty?: unknown };
  const item = String(obj.item ?? "").trim();
  const qty = obj.qty != null && obj.qty !== "null" ? String(obj.qty).trim() : "";
  return qty ? `${qty} ${item}` : item;
}

/**
 * Format one exercise element — handles BOTH old object shape and new
 * string shape.
 *   Old: { name: string; reps: string | null }
 *   New: string
 */
function formatExercise(el: unknown): string {
  if (typeof el === "string") return el.trim();
  const obj = el as { name?: unknown; reps?: unknown };
  const name = String(obj.name ?? "").trim();
  const reps = obj.reps != null && obj.reps !== "null" ? String(obj.reps).trim() : "";
  return reps ? `${name} — ${reps}` : name;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** True when the field value is absent, or is/contains "[object Object]". */
function isCorruptOrAbsent(value: unknown): boolean {
  if (value == null) return true;
  if (!Array.isArray(value)) return true;
  if (value.length === 0) return false;
  return value.some(v => String(v).includes("[object Object]"));
}

/** True when string arrays differ (order-sensitive). */
function differs(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return true;
  return a.some((v, i) => v !== b[i]);
}

/** Build a Map<roostId, TFile> by scanning vault.getMarkdownFiles(). */
function buildIdIndex(plugin: IRoostPlugin): Map<string, TFile> {
  const index = new Map<string, TFile>();
  for (const file of plugin.app.vault.getMarkdownFiles()) {
    const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
    if (typeof fm?.roost_id === "string") {
      index.set(fm.roost_id, file);
    }
  }
  return index;
}

/** Write backup of the cache to <name>.PRE-RECOVER-BACKUP.json. */
function writeBackup(vaultRoot: string, filename: string, data: unknown): void {
  const dir = cacheDir(vaultRoot);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const backupName = filename.replace(/\.json$/, ".PRE-RECOVER-BACKUP.json");
    fs.writeFileSync(cachePath(vaultRoot, backupName), JSON.stringify(data));
  } catch (e: unknown) {
    console.warn(`[roost] recover: failed to write backup for ${filename}:`, e instanceof Error ? e.message : String(e));
  }
}

// ── Per-pipeline recovery ─────────────────────────────────────────────────────

interface PipelineSpec {
  cacheFile: string;
  frontmatterKey: string;
  /** Extract the raw array (objects or strings) from a cache entry's extraction object. */
  getArray: (extraction: Record<string, unknown>) => unknown[] | null;
  formatFn: (el: unknown) => string;
}

const PIPELINES: PipelineSpec[] = [
  {
    cacheFile: "recipe-cache.json",
    frontmatterKey: "recipe_ingredients",
    getArray: (ex) => {
      const arr = ex.ingredients;
      return Array.isArray(arr) ? arr : null;
    },
    formatFn: formatIngredient,
  },
  {
    cacheFile: "workouts-cache.json",
    frontmatterKey: "workout_exercises",
    getArray: (ex) => {
      const arr = ex.exercises;
      return Array.isArray(arr) ? arr : null;
    },
    formatFn: formatExercise,
  },
];

async function recoverPipeline(
  plugin: IRoostPlugin,
  spec: PipelineSpec,
  idIndex: Map<string, TFile>,
): Promise<number> {
  const vault = plugin.app.vault;
  const vaultRoot = vaultBasePath(vault);

  // 1. Load cache
  const cache = loadPipelineCache<Record<string, unknown>>(vault, spec.cacheFile);

  // 2. Snapshot backup
  writeBackup(vaultRoot, spec.cacheFile, cache);

  let fixed = 0;

  for (const [roostId, entry] of Object.entries(cache)) {
    const extraction = (entry as Record<string, unknown>).extraction;
    if (!extraction || typeof extraction !== "object") continue;

    const rawArray = spec.getArray(extraction as Record<string, unknown>);
    if (!rawArray || rawArray.length === 0) continue;

    // Format the cache array to string[]
    const recovered = rawArray
      .map(spec.formatFn)
      .filter(s => s.length > 0);

    if (recovered.length === 0) continue;

    // Find the note
    const file = idIndex.get(roostId);
    if (!file) continue;

    // Read current frontmatter
    const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    const current = fm[spec.frontmatterKey];

    // Decide whether to write
    const needsWrite =
      isCorruptOrAbsent(current) ||
      (Array.isArray(current) && differs(current as string[], recovered));

    if (!needsWrite) continue;

    // Write only the one frontmatter key
    const content = await vault.read(file);
    const updated = updateNoteFrontmatter(content, { [spec.frontmatterKey]: recovered });
    if (updated !== null) {
      await vault.modify(file, updated);
      fixed++;
    }
  }

  return fixed;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function recoverStructuredFrontmatter(
  plugin: IRoostPlugin,
): Promise<RecoverResult> {
  const idIndex = buildIdIndex(plugin);

  const recipesFixed = await recoverPipeline(plugin, PIPELINES[0], idIndex);
  const workoutsFixed = await recoverPipeline(plugin, PIPELINES[1], idIndex);

  return { recipesFixed, workoutsFixed };
}
