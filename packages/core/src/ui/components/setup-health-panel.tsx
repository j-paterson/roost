/**
 * SetupHealthPanel — surfaces pending one-shot migrations above the vault
 * health rows. Scans for:
 *   1. Pipelines/Recipes/ folder with .md files  → recipe migration row
 *   2. Pipelines/Places/ folder with .md files   → place migration row
 *   3. Bookmarks with pipeline_v_media or enrichment_v_media frontmatter
 *      fields                                     → namespace migration row
 *
 * Each row shows a warning icon, a count label, and a [Migrate] button that
 * fires the corresponding roost: Obsidian command.
 */
import * as React from "react";
import { useState, useEffect } from "react";
import { App, TFile, TFolder } from "obsidian";
import { Button } from "@/ui/components/ui/button";

interface MigrationStatus {
  recipePending: number;   // # of .md files in Pipelines/Recipes/
  placePending: number;    // # of .md files in Pipelines/Places/
  namespacePending: number; // # of bookmarks with legacy namespace fields
}

/** Count markdown files recursively in a folder */
function countMarkdownFiles(folder: TFolder): number {
  let count = 0;
  for (const child of folder.children) {
    if (child instanceof TFolder) count += countMarkdownFiles(child);
    else if (child instanceof TFile && child.extension === "md") count++;
  }
  return count;
}

/** Scan the vault for pending migrations */
function scanMigrations(app: App, syncFolder: string): MigrationStatus {
  const vault = app.vault;
  const cache = app.metadataCache;

  // 1. Recipe folder
  const recipeRoot = vault.getAbstractFileByPath("Pipelines/Recipes");
  const recipePending = recipeRoot instanceof TFolder
    ? countMarkdownFiles(recipeRoot)
    : 0;

  // 2. Places folder
  const placeRoot = vault.getAbstractFileByPath("Pipelines/Places");
  const placePending = placeRoot instanceof TFolder
    ? countMarkdownFiles(placeRoot)
    : 0;

  // 3. Namespace fields on bookmarks
  let namespacePending = 0;
  for (const file of vault.getMarkdownFiles()) {
    // Only scan inside the configured sync folder
    if (!file.path.startsWith(syncFolder + "/")) continue;
    const fm = cache.getFileCache(file)?.frontmatter;
    if (!fm) continue;
    if ("pipeline_v_media" in fm || "enrichment_v_media" in fm) {
      namespacePending++;
    }
  }

  return { recipePending, placePending, namespacePending };
}

interface SetupHealthPanelProps {
  app: App;
  syncFolder: string;
  /** Bump to force a re-scan from outside (e.g. after a migration completes). */
  refreshToken?: number;
}

export function SetupHealthPanel({ app, syncFolder, refreshToken }: SetupHealthPanelProps) {
  const [status, setStatus] = useState<MigrationStatus | null>(null);

  useEffect(() => {
    const s = scanMigrations(app, syncFolder);
    setStatus(s);
  }, [app, syncFolder, refreshToken]);

  if (!status) return null;

  const rows: React.ReactNode[] = [];

  if (status.recipePending > 0) {
    rows.push(
      <MigrationRow
        key="recipe"
        label={`${status.recipePending} Recipe pipeline note${status.recipePending !== 1 ? "s" : ""} to migrate`}
        commandId="roost:migrate-recipe-pipeline"
        app={app}
        onDone={() => setStatus(prev => prev ? { ...prev, recipePending: 0 } : prev)}
      />
    );
  }

  if (status.placePending > 0) {
    rows.push(
      <MigrationRow
        key="place"
        label={`${status.placePending} Place pipeline note${status.placePending !== 1 ? "s" : ""} to migrate`}
        commandId="roost:migrate-place-pipeline"
        app={app}
        onDone={() => setStatus(prev => prev ? { ...prev, placePending: 0 } : prev)}
      />
    );
  }

  if (status.namespacePending > 0) {
    rows.push(
      <MigrationRow
        key="namespace"
        label={`${status.namespacePending} bookmark${status.namespacePending !== 1 ? "s" : ""} need namespace migration`}
        commandId="roost:migrate-pipeline-namespaces"
        app={app}
        onDone={() => setStatus(prev => prev ? { ...prev, namespacePending: 0 } : prev)}
      />
    );
  }

  if (rows.length === 0) return null;

  return <>{rows}</>;
}

interface MigrationRowProps {
  label: string;
  commandId: string;
  app: App;
  onDone: () => void;
}

function MigrationRow({ label, commandId, app, onDone }: MigrationRowProps) {
  const [migrating, setMigrating] = useState(false);

  async function handleMigrate() {
    setMigrating(true);
    try {
      await (app as App & { commands: { executeCommandById(id: string): boolean } })
        .commands
        .executeCommandById(commandId);
      // Give the vault a moment to settle before removing the row
      setTimeout(onDone, 800);
    } finally {
      setMigrating(false);
    }
  }

  return (
    <div
      className="shrink-0 border-t border-border bg-card text-xs flex items-center gap-2 px-3 py-2"
      style={{ color: "var(--text-warning, #c76f00)" }}
    >
      <span style={{ flexShrink: 0 }}>⚠</span>
      <span className="flex-1">{label}</span>
      <Button
        variant="outline"
        size="sm"
        loading={migrating}
        disabled={migrating}
        onClick={handleMigrate}
      >
        Migrate
      </Button>
    </div>
  );
}
