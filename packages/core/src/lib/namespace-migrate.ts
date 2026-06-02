import { Notice, TFile } from "obsidian";
import type { IRoostPlugin } from "@/types/plugin";
import { updateNoteFrontmatter, type FrontmatterValue } from "@/lib/vault-helpers";

const LEGACY_RENAMES: Array<[from: string, to: string]> = [
  ["pipeline_v_media", "enrichment_v_mediaExtraction"],
  ["enrichment_v_media", "enrichment_v_mediaFiles"],
];

export function renameNamespacesInFrontmatter(
  fm: Record<string, unknown>,
): { updated: Record<string, unknown>; renamed: number } {
  const updated: Record<string, unknown> = { ...fm };
  let renamed = 0;
  for (const [from, to] of LEGACY_RENAMES) {
    if (!(from in updated)) continue;
    const legacyValue = updated[from];
    delete updated[from];
    if (!(to in updated)) {
      updated[to] = legacyValue;
    }
    renamed++;
  }
  return { updated, renamed };
}

let migrationRunning = false;

export async function runNamespaceMigration(plugin: IRoostPlugin): Promise<void> {
  if (migrationRunning) { new Notice("Namespace migration already running"); return; }
  migrationRunning = true;
  try {
    const vault = plugin.app.vault;
    let totalRenamed = 0;
    let filesTouched = 0;
    for (const file of vault.getMarkdownFiles()) {
      const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!fm) continue;
      const { renamed } = renameNamespacesInFrontmatter(fm);
      if (renamed === 0) continue;
      const updatesForWrite: Record<string, FrontmatterValue> = {};
      for (const [from, to] of LEGACY_RENAMES) {
        if (from in fm) {
          const v = (fm as Record<string, unknown>)[from];
          if (typeof v === "number" && !(to in fm)) updatesForWrite[to] = v;
          updatesForWrite[from] = null;
        }
      }
      if (Object.keys(updatesForWrite).length === 0) continue;
      const content = await vault.read(file);
      const updated = updateNoteFrontmatter(content, updatesForWrite);
      if (updated !== null) {
        await vault.modify(file, updated);
        filesTouched++;
        totalRenamed += renamed;
      }
    }
    const summary = `Namespace migration: ${filesTouched} files touched, ${totalRenamed} fields renamed`;
    new Notice(summary);
    console.log("[namespace-migrate]", summary);
  } finally { migrationRunning = false; }
}
