/**
 * One-shot migration: walk Pipelines/Places/**\/*.md notes from the old
 * pipeline output format, copy their extracted fields back onto the source
 * bookmark's frontmatter (using the new place_* schema), then delete the
 * synthesized note.
 *
 * Idempotent — running twice is a no-op once Pipelines/Places has been
 * fully migrated. Notes the migration can't resolve (missing source_id,
 * source bookmark not found) are left in place and reported, so the user
 * can investigate without losing data.
 *
 * Triggered from the Obsidian command palette: "Migrate Places pipeline
 * notes to bookmark frontmatter".
 */
import { Notice, TFile, TFolder } from "obsidian";
import type { IRoostPlugin } from "@/types/plugin";
import { updateNoteFrontmatter, type FrontmatterValue } from "@/lib/vault-helpers";
import { PLACE_FIELDS } from "@/pipeline/places-pipeline";

const PIPELINES_PLACE_FOLDER = "Pipelines/Places";

interface MigrationResult {
  migrated: number;
  alreadyMigrated: number;
  unresolved: number;
  errors: number;
  skippedIndexes: number;
}

let migrationRunning = false;

export async function runPlacePipelineMigration(plugin: IRoostPlugin): Promise<void> {
  if (migrationRunning) {
    new Notice("Places migration is already running.");
    return;
  }
  migrationRunning = true;
  try {
    const log = (msg: string) => { plugin.fireLog("[place-migrate] " + msg); };
    const vault = plugin.app.vault;

    const root = vault.getAbstractFileByPath(PIPELINES_PLACE_FOLDER);
    if (!(root instanceof TFolder)) {
      new Notice("No Pipelines/Places folder found — nothing to migrate.");
      return;
    }

    // Collect every .md under Pipelines/Places/. Skips the master + per-country
    // index notes (recognized by their pipeline frontmatter values), since
    // those are derived data that the new tabular BasesView replaces.
    const noteFiles: TFile[] = [];
    const indexNoteFiles: TFile[] = [];
    collectMarkdown(root, (file) => {
      const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
      const pipelineKind = fm?.pipeline;
      if (
        pipelineKind === "places-index" ||
        pipelineKind === "places-country-index"
      ) {
        indexNoteFiles.push(file);
      } else {
        noteFiles.push(file);
      }
    });

    if (noteFiles.length === 0 && indexNoteFiles.length === 0) {
      new Notice("Pipelines/Places is empty — nothing to migrate.");
      return;
    }

    log(`Found ${noteFiles.length} extraction notes + ${indexNoteFiles.length} index notes`);
    new Notice(`Migrating ${noteFiles.length} place notes…`);

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

        // Only process notes written by the old places pipeline
        const pipelineKind = fm?.pipeline;
        if (pipelineKind !== "places" && pipelineKind !== "place") {
          result.unresolved++;
          log(`Unexpected pipeline kind '${pipelineKind}': ${file.path}`);
          continue;
        }

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
        // new enrichment_v_place version field set, skip without rewriting.
        const sourceFm = plugin.app.metadataCache.getFileCache(sourceFile)?.frontmatter;
        if (sourceFm && typeof sourceFm[PLACE_FIELDS.version] === "number") {
          result.alreadyMigrated++;
          // Still delete the redundant Pipelines/Places note.
          await vault.delete(file);
          continue;
        }

        // Reconstruct extraction from the old note's frontmatter fields.
        const name = stringFm(fm.name) ?? stringFm(fm.place) ?? "";
        const city = stringFm(fm.city) ?? "";
        const country = stringFm(fm.country) ?? "";
        const placeType = stringFm(fm.place_type) ?? "";
        const bestFor = stringFm(fm.best_for) ?? "";
        const address = stringFm(fm.address) ?? null;
        const lat = parseLng(fm.lat);
        const lng = parseLng(fm.lng);
        const description = stringFm(fm.description) ?? null;
        const vibes: string[] = Array.isArray(fm.vibes)
          ? (fm.vibes as unknown[]).map(v => String(v)).filter(Boolean)
          : [];
        const tips: string[] = Array.isArray(fm.tips)
          ? (fm.tips as unknown[]).map(v => String(v)).filter(Boolean)
          : [];

        const updates: Record<string, FrontmatterValue> = {
          [PLACE_FIELDS.name]: name,
          [PLACE_FIELDS.city]: city,
          [PLACE_FIELDS.country]: country,
          [PLACE_FIELDS.type]: placeType,
          [PLACE_FIELDS.address]: address,
          [PLACE_FIELDS.bestFor]: bestFor || null,
          [PLACE_FIELDS.lat]: lat,
          [PLACE_FIELDS.lng]: lng,
          [PLACE_FIELDS.description]: description,
          [PLACE_FIELDS.vibes]: vibes,
          [PLACE_FIELDS.tips]: tips,
          [PLACE_FIELDS.version]: 1,
        };

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
    // them. Delete unconditionally.
    for (const idx of indexNoteFiles) {
      try { await vault.delete(idx); }
      catch (e: unknown) {
        log(`Failed to delete index ${idx.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Try to remove now-empty country folders (and the parent Pipelines/Places
    // if it ends up empty). Wrap each in try/catch — vault.delete on a
    // non-empty folder fails; leave survivors for manual inspection.
    const placeRoot = vault.getAbstractFileByPath(PIPELINES_PLACE_FOLDER);
    if (placeRoot instanceof TFolder) {
      // Attempt to clean up each country subfolder
      for (const child of [...placeRoot.children]) {
        if (child instanceof TFolder && child.children.length === 0) {
          try { await vault.delete(child); } catch { /* best-effort */ }
        }
      }
      // Then attempt to remove the root itself if empty
      const refreshed = vault.getAbstractFileByPath(PIPELINES_PLACE_FOLDER);
      if (refreshed instanceof TFolder && refreshed.children.length === 0) {
        try { await vault.delete(refreshed); } catch { /* best-effort */ }
      }
    }

    const summary = `Places migration: ${result.migrated} migrated, ${result.alreadyMigrated} already migrated, ${result.unresolved} unresolved, ${result.errors} errors, ${result.skippedIndexes} index notes deleted`;
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

/** Parse a lat/lng value that may be stored as a number or a string. */
function parseLng(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
