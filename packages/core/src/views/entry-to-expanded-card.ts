/**
 * Shared Bases entry → expanded-card payload and action chrome.
 */
import type { App, BasesEntry } from "obsidian";
import { setIcon, TFile } from "obsidian";
import { renderExpandedCard } from "@/ui/components/expanded-card";
import {
  entryStatsFromBases,
  getRoostId,
  parseEntryTags,
  safeGetValue,
  stripAuthorWiki,
} from "@/lib/bases-entry";
import { stripWikilink } from "@/lib/vault-utils";
import {
  getCoverFolder,
  resolveVideoUrl,
} from "@/views/feed/card-helpers";

export interface EntryMediaResolvers {
  resolveImageUrl: (entry: BasesEntry, propId: string) => string | null;
  resolveVideoUrl: (entry: BasesEntry) => string | null;
  resolveAllImages: (entry: BasesEntry) => string[];
  imagePropId: string;
}

/** Fallback post URL when frontmatter omits `url` (digest + Bases paths). */
export function sourceUrlFromFrontmatter(
  fm: Record<string, unknown>,
  author: string | null,
): string | null {
  const fmUrl = fm.url;
  if (typeof fmUrl === "string" && fmUrl.trim()) return fmUrl.trim();
  const roostId = fm.roost_id;
  if (typeof roostId !== "string") return null;
  const [platform, id] = roostId.split(":");
  if (!platform || !id) return null;
  if (platform === "twitter") return `https://x.com/i/status/${id}`;
  if (platform === "tiktok" && author?.startsWith("@")) {
    return `https://www.tiktok.com/${author}/video/${id}`;
  }
  return null;
}

/** Adapt vault frontmatter to Bases `note.*` property keys for shared card helpers. */
export function frontmatterBasesEntry(
  file: TFile,
  fm: Record<string, unknown>,
): BasesEntry {
  const values: Record<string, unknown> = {};
  const set = (key: string, value: unknown): void => {
    if (value !== undefined && value !== null) values[key] = value;
  };
  set("note.title", fm.title);
  set("note.platform", fm.platform);
  set("note.author", fm.author);
  set("note.url", fm.url);
  set("note.roost_id", fm.roost_id);
  set("note.cover", fm.cover);
  set("note.focal_index", fm.focal_index);
  set("note.stats_plays", fm.stats_plays);
  set("note.stats_likes", fm.stats_likes);
  set("note.stats_comments", fm.stats_comments);
  set("note.stats_shares", fm.stats_shares);
  if (Array.isArray(fm.tags)) {
    set("note.tags", fm.tags.map((t) => String(t)).join(", "));
  } else if (fm.tags != null) {
    set("note.tags", fm.tags);
  }
  return {
    file,
    getValue: (key: string) => values[key] ?? null,
  } as BasesEntry;
}

export interface DigestCardContext {
  attachFolder: string;
  hasTextBody: boolean;
  hideMediaPanel: boolean;
}

function digestCoverRaw(entry: BasesEntry): string {
  const coverValue = safeGetValue(entry, "note.cover");
  if (!coverValue) return "";
  return stripWikilink(coverValue.toString());
}

function digestHasThreadJson(app: App, folder: string): boolean {
  return (
    !!folder &&
    app.vault.getAbstractFileByPath(`${folder}/thread.json`) instanceof TFile
  );
}

/** Digest embed media policy (thread.json PNG rules, rasterized text covers). */
function resolveDigestAllImages(app: App, entry: BasesEntry): string[] {
  const folder = getCoverFolder(entry);
  if (!folder || resolveVideoUrl(app, entry)) return [];
  const coverRaw = digestCoverRaw(entry);
  const hasThreadJson = digestHasThreadJson(app, folder);
  const urls: string[] = [];
  for (let i = 1; i <= 20; i++) {
    const jpg = app.vault.getAbstractFileByPath(`${folder}/${i}.jpg`);
    if (jpg instanceof TFile) {
      urls.push(app.vault.getResourcePath(jpg));
      continue;
    }
    if (!hasThreadJson) {
      const png = app.vault.getAbstractFileByPath(`${folder}/${i}.png`);
      if (png instanceof TFile) {
        urls.push(app.vault.getResourcePath(png));
        continue;
      }
    }
    break;
  }
  return urls;
}

function resolveDigestCoverUrl(
  app: App,
  entry: BasesEntry,
  _propId: string,
): string | null {
  const coverRaw = digestCoverRaw(entry);
  if (!coverRaw) return null;
  const folder = coverRaw.replace(/\/[^/]+$/, "");
  const hasThreadJson = digestHasThreadJson(app, folder);
  const isCardPngCover = /\/card\.png$/i.test(coverRaw);
  const isNumberedPngCover = /\/\d+\.png$/i.test(coverRaw);
  const coverIsRasterizedText =
    isCardPngCover || (hasThreadJson && isNumberedPngCover);
  const videoUrl = resolveVideoUrl(app, entry);
  if (coverIsRasterizedText) {
    if (videoUrl) {
      const poster = app.vault.getAbstractFileByPath(`${folder}/video-poster.jpg`);
      if (poster instanceof TFile) return app.vault.getResourcePath(poster);
    }
    return null;
  }
  const f = app.vault.getAbstractFileByPath(coverRaw);
  if (f instanceof TFile) return app.vault.getResourcePath(f);
  return null;
}

/** Media resolvers for digest `roost-card` blocks (differs from gallery carousel PNG rules). */
export function digestMediaResolvers(app: App): EntryMediaResolvers {
  return {
    imagePropId: "note.cover",
    resolveVideoUrl: (entry) => resolveVideoUrl(app, entry),
    resolveAllImages: (entry) => resolveDigestAllImages(app, entry),
    resolveImageUrl: (entry, propId) => resolveDigestCoverUrl(app, entry, propId),
  };
}

/** Extra digest-only flags used when loading threaded body text. */
export function digestCardContext(
  app: App,
  entry: BasesEntry,
  resolvers: EntryMediaResolvers,
): DigestCardContext {
  const coverRaw = digestCoverRaw(entry);
  const folder = coverRaw ? coverRaw.replace(/\/[^/]+$/, "") : "";
  const hasThreadJson = digestHasThreadJson(app, folder);
  const isCardPngCover = /\/card\.png$/i.test(coverRaw);
  const videoUrl = resolvers.resolveVideoUrl(entry);
  const coverUrl = resolvers.resolveImageUrl(entry, resolvers.imagePropId);
  const allImageUrls = resolvers.resolveAllImages(entry);
  return {
    attachFolder: folder,
    hasTextBody: hasThreadJson || isCardPngCover,
    hideMediaPanel: !videoUrl && !coverUrl && allImageUrls.length === 0,
  };
}

export function entryToExpandedCardData(
  entry: BasesEntry,
  resolvers: EntryMediaResolvers,
  extraEls?: HTMLElement[],
) {
  return {
    title: safeGetValue(entry, "note.title")?.toString() ?? entry.file.basename,
    videoUrl: resolvers.resolveVideoUrl(entry),
    allImageUrls: resolvers.resolveAllImages(entry),
    coverUrl: resolvers.resolveImageUrl(entry, resolvers.imagePropId),
    platform: safeGetValue(entry, "note.platform")?.toString(),
    author: stripAuthorWiki(safeGetValue(entry, "note.author")),
    stats: entryStatsFromBases(entry),
    tags: parseEntryTags(entry),
    url:
      sourceUrlFromFrontmatter(
        {
          url: safeGetValue(entry, "note.url"),
          roost_id: safeGetValue(entry, "note.roost_id"),
        },
        stripAuthorWiki(safeGetValue(entry, "note.author")),
      ) ??
      safeGetValue(entry, "note.url")?.toString() ??
      null,
    startIndex: Number(safeGetValue(entry, "note.focal_index")) || undefined,
    extraEls,
  };
}

export interface ExpandedCardActionHandlers {
  entry: BasesEntry;
  app: App;
  onMove: (entry: BasesEntry) => void;
  onDelete?: (roostId: string) => void;
}

/** Mount expanded-card DOM into container; returns cleanup fn. */
export function mountExpandedCardHost(
  container: HTMLElement,
  entry: BasesEntry,
  resolvers: EntryMediaResolvers,
  extraEls?: HTMLElement[],
): () => void {
  container.addClass("roost-expanded");
  const cleanup = renderExpandedCard(container, entryToExpandedCardData(entry, resolvers, extraEls));
  return () => {
    cleanup();
    container.removeClass("roost-expanded");
  };
}

/** Move / Open note / Delete action row inside .roost-expanded-info. */
export function mountExpandedCardActions(
  container: HTMLElement,
  handlers: ExpandedCardActionHandlers,
): void {
  const info = container.querySelector(".roost-expanded-info") as HTMLElement | null;
  if (!info) return;

  const actions = info.createDiv({ cls: "roost-expanded-actions" });
  const moveBtn = actions.createDiv({ cls: "roost-expanded-action", text: "Move to…" });
  moveBtn.style.cursor = "pointer";
  moveBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    handlers.onMove(handlers.entry);
  });

  const openNote = actions.createDiv({ cls: "roost-expanded-action", text: "Open note →" });
  openNote.setAttr("title", handlers.entry.file.path);
  openNote.addEventListener("click", (e) => {
    e.stopPropagation();
    handlers.app.workspace.openLinkText(handlers.entry.file.path, "", false);
  });

  const roostId = getRoostId(handlers.entry);
  if (handlers.onDelete && roostId) {
    const deleteBtn = actions.createDiv({ cls: "roost-expanded-action roost-expanded-action-delete" });
    setIcon(deleteBtn.createSpan(), "trash-2");
    deleteBtn.setAttr("title", "Delete");
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      handlers.onDelete!(roostId);
    });
  }
}

/** Close button in the expanded card header (gallery in-place expand). */
export function mountExpandedCloseButton(
  cardEl: HTMLElement,
  onClose: () => void,
): void {
  const header = cardEl.querySelector(".roost-expanded-header");
  if (!header) return;
  const el = document.createElement("div");
  el.className = "roost-expanded-close";
  el.textContent = "✕";
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    onClose();
  });
  header.appendChild(el);
}
