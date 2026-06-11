/**
 * One-shot migration: walk Pipelines/Recipes/<sub>/*.md notes, copy fields
 * back onto source bookmark frontmatter, delete synthesized notes.
 * Idempotent — running twice is a no-op.
 */
import { Notice, TFile, TFolder } from "obsidian";
import type { IRoostPlugin } from "@/types/plugin";
import { updateNoteFrontmatter } from "@/lib/vault-helpers";
import { RECIPE_FIELDS, computeRecipeBackfillFields } from "@/pipeline/recipe-pipeline";

const PIPELINES_RECIPE_FOLDER = "Pipelines/Recipes";

interface MigrationResult {
  migrated: number;
  alreadyMigrated: number;
  unresolved: number;
  errors: number;
  skippedIndexes: number;
}

let migrationRunning = false;

export async function runRecipePipelineMigration(plugin: IRoostPlugin): Promise<void> {
  if (migrationRunning) { new Notice("Recipe migration already running"); return; }
  migrationRunning = true;
  try {
    const vault = plugin.app.vault;
    const result: MigrationResult = { migrated: 0, alreadyMigrated: 0, unresolved: 0, errors: 0, skippedIndexes: 0 };
    const log = (msg: string) => { console.log("[recipe-migrate]", msg); };

    const rootFolder = vault.getAbstractFileByPath(PIPELINES_RECIPE_FOLDER);
    if (!(rootFolder instanceof TFolder)) {
      new Notice("No Pipelines/Recipes folder; nothing to migrate.");
      return;
    }

    const allNoteFiles: TFile[] = [];
    const indexNoteFiles: TFile[] = [];
    collectMarkdown(rootFolder, (f) => {
      if (f.basename === "Recipe Index" || f.basename.endsWith(" Index")) {
        indexNoteFiles.push(f);
      } else {
        allNoteFiles.push(f);
      }
    });

    for (const file of allNoteFiles) {
      try {
        const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
        if (fm.pipeline !== "recipe") { log(`Skipping ${file.path}: not a recipe note`); continue; }
        const sourceId = stringFm(fm.source_id);
        if (!sourceId) { result.unresolved++; log(`No source_id in ${file.path}`); continue; }
        const sourceFile = findBookmarkByRoostId(plugin, sourceId);
        if (!sourceFile) { result.unresolved++; log(`No bookmark for ${sourceId}`); continue; }
        const sourceFm = plugin.app.metadataCache.getFileCache(sourceFile)?.frontmatter ?? {};
        if (typeof sourceFm[RECIPE_FIELDS.version] === "number") {
          result.alreadyMigrated++;
          await vault.delete(file);
          continue;
        }
        const extraction = {
          dish: stringFm(fm.dish) ?? "Unknown",
          cuisine: stringFm(fm.cuisine) ?? "Unknown",
          ingredients: Array.isArray(fm.ingredients) ? fm.ingredients.map(String) : [],
          steps: Array.isArray(fm.steps) ? fm.steps.map(String) : [],
          prepTime: stringFm(fm.prep_time),
          cookTime: stringFm(fm.cook_time),
          difficulty: (fm.difficulty === "easy" || fm.difficulty === "hard") ? fm.difficulty : "medium" as const,
          notes: null,
          recipeLink: null,
        };
        const updates = computeRecipeBackfillFields(extraction as unknown as Parameters<typeof computeRecipeBackfillFields>[0], sourceFm);
        const content = await vault.read(sourceFile);
        const updated = updateNoteFrontmatter(content, updates);
        if (updated !== null) await vault.modify(sourceFile, updated);
        await vault.delete(file);
        result.migrated++;
      } catch (e: unknown) {
        result.errors++;
        log(`Error on ${file.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    for (const idx of indexNoteFiles) {
      try { await vault.delete(idx); result.skippedIndexes++; }
      catch { /* best-effort */ }
    }

    await cleanupEmptyFolders(vault, rootFolder);

    const summary = `Recipe migration: ${result.migrated} migrated, ${result.alreadyMigrated} already migrated, ${result.unresolved} unresolved, ${result.errors} errors, ${result.skippedIndexes} index notes deleted`;
    log(summary);
    new Notice(summary);
  } finally { migrationRunning = false; }
}

function collectMarkdown(folder: TFolder, onFile: (file: TFile) => void): void {
  for (const child of folder.children) {
    if (child instanceof TFolder) collectMarkdown(child, onFile);
    else if (child instanceof TFile && child.extension === "md") onFile(child);
  }
}

function findBookmarkByRoostId(plugin: IRoostPlugin, roostId: string): TFile | null {
  for (const file of plugin.app.vault.getMarkdownFiles()) {
    const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
    if (fm?.roost_id === roostId) return file;
  }
  return null;
}

function stringFm(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return null;
}

async function cleanupEmptyFolders(vault: import("obsidian").Vault, root: TFolder): Promise<void> {
  for (const child of [...root.children]) {
    if (child instanceof TFolder) {
      await cleanupEmptyFolders(vault, child);
      if (child.children.length === 0) {
        try { await vault.delete(child); } catch { /* best-effort */ }
      }
    }
  }
  if (root.children.length === 0) {
    try { await vault.delete(root); } catch { /* best-effort */ }
  }
}
