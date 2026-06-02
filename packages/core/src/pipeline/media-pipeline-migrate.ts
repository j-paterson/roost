/**
 * One-shot migration: walk Pipelines/Media/<Type>/*.md notes from the old
 * pipeline output format, copy their extracted fields back onto the source
 * bookmark's frontmatter (using the new media_* schema), then delete the
 * synthesized note.
 *
 * Idempotent — running twice is a no-op once Pipelines/Media has been
 * fully migrated. Notes the migration can't resolve (missing source_id,
 * source bookmark not found) are left in place and reported, so the user
 * can investigate without losing data.
 *
 * Triggered from the Obsidian command palette: "Migrate Media pipeline
 * notes to bookmark frontmatter".
 */
import { Notice, TFile, TFolder } from "obsidian";
import type { IRoostPlugin } from "@/types/plugin";
import { CATEGORY_FIELD, SUBCATEGORY_FIELD } from "@/config";
import { updateNoteFrontmatter, type FrontmatterValue } from "@/lib/vault-helpers";
import { MEDIA_FIELDS, MEDIA_TYPE_DISPLAY } from "@/pipeline/media-pipeline";

const PIPELINES_MEDIA_FOLDER = "Pipelines/Media";

interface MigrationResult {
  migrated: number;
  alreadyMigrated: number;
  unresolved: number;
  errors: number;
  skippedIndexes: number;
}

let migrationRunning = false;

export async function runMediaPipelineMigration(plugin: IRoostPlugin): Promise<void> {
  if (migrationRunning) {
    new Notice("Media migration is already running.");
    return;
  }
  migrationRunning = true;
  try {
  const log = (msg: string) => { plugin.fireLog("[media-migrate] " + msg); };
  const vault = plugin.app.vault;

  const root = vault.getAbstractFileByPath(PIPELINES_MEDIA_FOLDER);
  if (!(root instanceof TFolder)) {
    new Notice("No Pipelines/Media folder found — nothing to migrate.");
    return;
  }

  // Collect every .md under Pipelines/Media/. Skips the master + per-type
  // index notes (recognized by their pipeline frontmatter values), since
  // those are derived data that the new tabular BasesView replaces.
  const noteFiles: TFile[] = [];
  const indexNoteFiles: TFile[] = [];
  collectMarkdown(root, (file) => {
    const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
    const pipelineKind = fm?.pipeline;
    if (pipelineKind === "media-index" || pipelineKind === "media-type-index") {
      indexNoteFiles.push(file);
    } else {
      noteFiles.push(file);
    }
  });

  if (noteFiles.length === 0 && indexNoteFiles.length === 0) {
    new Notice("Pipelines/Media is empty — nothing to migrate.");
    return;
  }

  log(`Found ${noteFiles.length} extraction notes + ${indexNoteFiles.length} index notes`);
  new Notice(`Migrating ${noteFiles.length} media notes…`);

  const result: MigrationResult = {
    migrated: 0,
    alreadyMigrated: 0,
    unresolved: 0,
    errors: 0,
    skippedIndexes: indexNoteFiles.length,
  };

  for (const file of noteFiles) {
    try {
      const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!fm) { result.unresolved++; log(`No frontmatter: ${file.path}`); continue; }

      const sourceId = typeof fm.source_id === "string" ? fm.source_id : null;
      if (!sourceId) {
        result.unresolved++;
        log(`Missing source_id: ${file.path}`);
        continue;
      }

      const sourceFile = findBookmarkByRoostId(plugin, sourceId);
      if (!sourceFile) {
        result.unresolved++;
        log(`Source bookmark not found for ${sourceId}: ${file.path}`);
        continue;
      }

      // Already-migrated check — if the source bookmark already has the
      // new media_title field set, skip without rewriting (idempotent).
      const sourceFm = plugin.app.metadataCache.getFileCache(sourceFile)?.frontmatter;
      if (sourceFm && typeof sourceFm[MEDIA_FIELDS.title] === "string") {
        result.alreadyMigrated++;
        // Still delete the redundant Pipelines/Media note.
        await vault.delete(file);
        continue;
      }

      const updates: Record<string, FrontmatterValue> = {
        [MEDIA_FIELDS.title]: stringFm(fm.title),
        [MEDIA_FIELDS.creator]: stringFm(fm.creator),
        [MEDIA_FIELDS.genre]: stringFm(fm.genre),
        [MEDIA_FIELDS.rating]: stringFm(fm.rating) ?? null,
        [MEDIA_FIELDS.where]: stringFm(fm.where) ?? null,
        [MEDIA_FIELDS.version]: 1,
      };

      // Use the old note's media_type to drive roost_subcategory backfill
      // when the source bookmark has none. Mirrors writeMediaToBookmark's
      // rule 2 — never overrides existing user curation.
      const oldMediaType = stringFm(fm.media_type);
      const sourceCategory = typeof sourceFm?.[CATEGORY_FIELD] === "string"
        ? sourceFm[CATEGORY_FIELD] as string : null;
      const sourceSubcategory = typeof sourceFm?.[SUBCATEGORY_FIELD] === "string"
        ? sourceFm[SUBCATEGORY_FIELD] as string : null;
      if (oldMediaType && !sourceSubcategory) {
        const displayName = MEDIA_TYPE_DISPLAY[oldMediaType as keyof typeof MEDIA_TYPE_DISPLAY];
        if (displayName) {
          if (!sourceCategory) {
            updates[CATEGORY_FIELD] = "Media";
            updates[SUBCATEGORY_FIELD] = displayName;
          } else if (sourceCategory === "Media") {
            updates[SUBCATEGORY_FIELD] = displayName;
          }
        }
      }
      const sourceContent = await vault.read(sourceFile);
      const updated = updateNoteFrontmatter(sourceContent, updates);
      if (updated && updated !== sourceContent) {
        await vault.modify(sourceFile, updated);
      }
      await vault.delete(file);
      result.migrated++;
    } catch (e: unknown) {
      result.errors++;
      log(`Error on ${file.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Index notes are pure derived data — the new tabular BasesView replaces
  // them. Delete unconditionally; if the user wants the historical view back,
  // it's reproducible from the migrated frontmatter.
  for (const idx of indexNoteFiles) {
    try { await vault.delete(idx); }
    catch (e: unknown) { log(`Failed to delete index ${idx.path}: ${e instanceof Error ? e.message : String(e)}`); }
  }

  // Try to remove the now-empty type folders (and the parent Pipelines/Media
  // if it ends up empty). vault.delete on a folder fails noisily if it's
  // not empty — wrap each in try/catch and let the noisy ones survive for
  // the user to inspect manually.
  for (const display of Object.values(MEDIA_TYPE_DISPLAY)) {
    const folder = vault.getAbstractFileByPath(`${PIPELINES_MEDIA_FOLDER}/${display}`);
    if (folder instanceof TFolder && folder.children.length === 0) {
      try { await vault.delete(folder); } catch { /* best-effort */ }
    }
  }
  const mediaRoot = vault.getAbstractFileByPath(PIPELINES_MEDIA_FOLDER);
  if (mediaRoot instanceof TFolder && mediaRoot.children.length === 0) {
    try { await vault.delete(mediaRoot); } catch { /* best-effort */ }
  }

  const summary = `Media migration: ${result.migrated} migrated, ${result.alreadyMigrated} already migrated, ${result.unresolved} unresolved, ${result.errors} errors, ${result.skippedIndexes} index notes deleted`;
  log(summary);
  new Notice(summary);
  } finally {
    migrationRunning = false;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function collectMarkdown(folder: TFolder, onFile: (file: TFile) => void): void {
  for (const child of folder.children) {
    if (child instanceof TFolder) collectMarkdown(child, onFile);
    else if (child instanceof TFile && child.extension === "md") onFile(child);
  }
}

function findBookmarkByRoostId(plugin: IRoostPlugin, roostId: string): TFile | null {
  const files = plugin.app.vault.getMarkdownFiles();
  for (const file of files) {
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
