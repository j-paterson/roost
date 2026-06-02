/**
 * Gallery folder cards — stacked thumbnails for Smart Assign / folder drill-down.
 */
import type { BasesEntry } from "obsidian";
import type { FolderView } from "@/types/roost";
import { safeGetValue } from "@/lib/bases-entry";

const COHESION_HIGH = 0.8;
const COHESION_MID = 0.7;

export interface GalleryFolderCardsContext {
  cardSize: number;
  entries: BasesEntry[] | undefined;
  imagePropId: string;
  resolveImageUrl: (entry: BasesEntry, propId: string) => string | null;
  onFolderClick: (folder: FolderView) => void;
}

function applyFolderCardsGridStyle(container: HTMLElement, cardSize: number): void {
  container.style.cssText = `
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(${cardSize}px, 1fr));
      grid-auto-flow: dense;
      gap: 12px;
      padding: 12px;
    `;
}

/** Render folder cards with stacked thumbnails — ported from Electron's FolderCard */
export function renderGalleryFolderCards(
  container: HTMLElement,
  folders: FolderView[],
  ctx: GalleryFolderCardsContext,
): void {
  container.empty();
  applyFolderCardsGridStyle(container, ctx.cardSize);

  const neededIds = new Set<string>();
  for (const folder of folders) {
    for (const id of folder.itemIds.slice(0, 3)) neededIds.add(id);
  }
  const coverByRoostId = new Map<string, string>();
  const entries = ctx.entries;
  if (entries) {
    for (const entry of entries) {
      const id = safeGetValue(entry, "note.roost_id")?.toString();
      if (!id || !neededIds.has(id)) continue;
      const url = ctx.resolveImageUrl(entry, ctx.imagePropId);
      if (url) coverByRoostId.set(id, url);
      if (coverByRoostId.size >= neededIds.size) break;
    }
  }

  for (const folder of folders) {
    const card = container.createDiv({ cls: "roost-folder-card" });

    const stack = card.createDiv({ cls: "roost-folder-stack" });
    const thumbIds = folder.itemIds.slice(0, 3);
    const thumbUrls = thumbIds.map(id => coverByRoostId.get(id)).filter(Boolean) as string[];

    if (thumbUrls.length >= 3) {
      const back = stack.createDiv({ cls: "roost-folder-thumb roost-folder-thumb-back" });
      back.createEl("img", { attr: { src: thumbUrls[2] } });
    }
    if (thumbUrls.length >= 2) {
      const mid = stack.createDiv({ cls: "roost-folder-thumb roost-folder-thumb-mid" });
      mid.createEl("img", { attr: { src: thumbUrls[1] } });
    }
    const front = stack.createDiv({ cls: "roost-folder-thumb roost-folder-thumb-front" });
    if (thumbUrls.length > 0) {
      front.createEl("img", { attr: { src: thumbUrls[0] } });
    } else {
      front.createDiv({ cls: "roost-folder-empty", text: folder.count > 0 ? `${folder.count}` : "Empty" });
    }

    const label = card.createDiv({ cls: "roost-folder-label" });
    label.createDiv({ cls: "roost-folder-name", text: folder.name });
    const meta = label.createDiv({ cls: "roost-folder-meta" });
    meta.createSpan({ text: `${folder.count} items` });
    if (folder.cohesion != null) {
      const pct = Math.round(folder.cohesion * 100);
      const cls = folder.cohesion > COHESION_HIGH ? "roost-cohesion-high" : folder.cohesion > COHESION_MID ? "roost-cohesion-mid" : "roost-cohesion-low";
      meta.createSpan({ cls: `roost-folder-cohesion ${cls}`, text: `${pct}%` });
    }

    card.addEventListener("click", () => ctx.onFolderClick(folder));
  }
}
