/**
 * Auto-create Obsidian Bases files for browsing bookmarks.
 * Creates .base files that query the sync folder with table + cards views.
 */
import { Vault, TFile } from "obsidian";

export async function ensureBasesFiles(vault: Vault, syncFolder: string): Promise<void> {
  await ensureBaseFile(vault, `${syncFolder}/All Bookmarks.base`, {
    folder: syncFolder,
    views: [
      {
        type: "roost-bookmarks",
        name: "Gallery",
        image: "note.cover",
        cardSize: 180,
        imageAspectRatio: 1.0,
        order: ["file.name", "note.platform", "note.author", "note.collection", "note.tags"],
      },
      {
        type: "table",
        name: "Table",
        order: ["file.name", "note.title", "note.platform", "note.author", "note.collection", "note.published", "note.stats_likes"],
        sort: [{ column: "note.saved", direction: "DESC" }],
      },
    ],
  });
}

interface BaseConfig {
  folder: string;
  views: BaseView[];
}

interface BaseView {
  type: string;
  name: string;
  image?: string;
  cardSize?: number;
  imageAspectRatio?: number;
  imageFit?: string;
  order: string[];
  sort?: { column: string; direction: "ASC" | "DESC" }[];
}

async function ensureBaseFile(vault: Vault, path: string, config: BaseConfig): Promise<void> {
  const existing = vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    // File already exists. Append any views from `config.views` that aren't
    // already declared so plugin upgrades (e.g. adding the Media list view)
    // reach users who set up the .base before that view existed. Doesn't
    // touch existing view configurations — user customizations survive.
    await appendMissingViews(vault, existing, config.views);
    return;
  }

  const lines: string[] = [];

  // Filters — require roost_id to exclude non-bookmark files
  lines.push("filters:");
  lines.push("  and:");
  lines.push(`    - file.inFolder("${config.folder}")`);
  lines.push(`    - note.roost_id`);
  lines.push("");

  // Views
  lines.push("views:");
  for (const view of config.views) {
    lines.push(`  - type: ${view.type}`);
    lines.push(`    name: "${view.name}"`);
    if (view.image) lines.push(`    image: ${view.image}`);
    if (view.cardSize) lines.push(`    cardSize: ${view.cardSize}`);
    if (view.imageAspectRatio != null) lines.push(`    imageAspectRatio: ${view.imageAspectRatio}`);
    if (view.imageFit) lines.push(`    imageFit: "${view.imageFit}"`);
    lines.push("    order:");
    for (const col of view.order) lines.push(`      - ${col}`);
    if (view.sort) {
      lines.push("    sort:");
      for (const s of view.sort) {
        lines.push(`      - column: ${s.column}`);
        lines.push(`        direction: ${s.direction}`);
      }
    }
  }

  await vault.create(path, lines.join("\n") + "\n");
}

/** Append views that aren't yet declared in the existing .base file. Detects
 *  via a simple `type: <name>` substring match — sufficient because Bases
 *  view types are short identifiers and the rest of the .base YAML doesn't
 *  contain `type:` lines at the views level. */
async function appendMissingViews(vault: Vault, file: TFile, views: BaseView[]): Promise<void> {
  const existing = await vault.read(file);
  const missing = views.filter(v => !existing.includes(`type: ${v.type}`));
  if (missing.length === 0) return;

  const lines: string[] = existing.endsWith("\n") ? [existing.slice(0, -1)] : [existing];
  if (!existing.includes("views:")) lines.push("views:");
  for (const view of missing) {
    lines.push(`  - type: ${view.type}`);
    lines.push(`    name: "${view.name}"`);
    if (view.image) lines.push(`    image: ${view.image}`);
    if (view.cardSize) lines.push(`    cardSize: ${view.cardSize}`);
    if (view.imageAspectRatio != null) lines.push(`    imageAspectRatio: ${view.imageAspectRatio}`);
    if (view.imageFit) lines.push(`    imageFit: "${view.imageFit}"`);
    lines.push("    order:");
    for (const col of view.order) lines.push(`      - ${col}`);
    if (view.sort) {
      lines.push("    sort:");
      for (const s of view.sort) {
        lines.push(`      - column: ${s.column}`);
        lines.push(`        direction: ${s.direction}`);
      }
    }
  }
  await vault.modify(file, lines.join("\n") + "\n");
}
