/**
 * Gallery card DOM — placeholder creation and hydration into full cards.
 */
import { setIcon, type BasesEntry } from "obsidian";
import { CATEGORY_FIELD } from "@/config";
import type { MatchDetail } from "@/types/roost";
import { safeGetValue } from "@/lib/bases-entry";
import { cleanCaption } from "@/lib/caption";
import { ENRICHMENTS } from "@/lib/enrichments";
import { getPipelineData, renderPipelineOverlay } from "@/views/pipeline-details";
import { renderChip } from "@/views/pipeline-views/shared/chip";
import { setupGalleryVideoScrub } from "@/views/gallery-video-scrub";
import type { GalleryExpandState } from "@/views/gallery-expanded";

export interface GalleryCardConfig {
  imagePropId: string;
  imageFit: string;
  imageRatio: number;
  showPlatform: boolean;
  showAuthor: boolean;
  showTags: boolean;
}

export interface GalleryCardHandlers {
  viewMode: "grid" | "feed";
  expandState: GalleryExpandState;
  uncertainRoostIds: Set<string> | null;
  matchedRoostIds: Set<string> | null;
  matchDetailMap: Map<string, MatchDetail> | null;
  isSelectionActive: () => boolean;
  isSelected: (roostId: string) => boolean;
  onSelectionToggle: (roostId: string, cardEl: HTMLElement) => void;
  onFeedSelect: (roostId: string) => void;
  onExpand: (cardEl: HTMLElement, entry: BasesEntry) => void;
  resolveImageUrl: (entry: BasesEntry, propId: string) => string | null;
  resolveVideoUrl: (entry: BasesEntry) => string | null;
  hasMultipleImages: (entry: BasesEntry) => boolean;
  /** True when the cover is a generated text card (card.png / threaded text
   *  page). These render as a text tile from note.title instead of an <img>. */
  isTextTileCover: (entry: BasesEntry) => boolean;
}

/** Render the cover area as a text tile (author + tweet body) instead of the
 *  generated card.png screenshot. Pulls text from note.title — no file read. */
function renderTextTileCover(coverEl: HTMLElement, entry: BasesEntry): void {
  coverEl.addClass("roost-card-cover-text");
  const authorValue = safeGetValue(entry, "note.author");
  if (authorValue) {
    const authorEl = coverEl.createDiv({ cls: "roost-card-cover-text-author" });
    authorEl.textContent = authorValue.toString().replace(/\[\[People\/|\]\]/g, "");
  }
  const rawText = safeGetValue(entry, "note.title")?.toString() ?? "";
  const text = cleanCaption(rawText) || rawText;
  if (text) {
    const bodyEl = coverEl.createDiv({ cls: "roost-card-cover-text-body" });
    bodyEl.textContent = text;
  }
}

/** Estimated card height from Bases view config sliders. */
export function estimateGalleryCardHeight(cardSize: number, imageRatioPct: number): number {
  const imageRatio = imageRatioPct / 100;
  return Math.round(cardSize * imageRatio + 50);
}

export function createGalleryPlaceholder(
  parent: HTMLElement,
  index: number,
  height: number,
  observer: IntersectionObserver | null,
): HTMLElement {
  const el = parent.createDiv({ cls: "roost-card roost-card-placeholder" });
  el.dataset.idx = String(index);
  el.style.minHeight = `${height}px`;
  el.createDiv({ cls: "roost-shimmer" });
  observer?.observe(el);
  return el;
}

/** Hydrate a placeholder into a full bookmark card. */
export function hydrateGalleryCard(
  el: HTMLElement,
  entry: BasesEntry,
  cfg: GalleryCardConfig,
  handlers: GalleryCardHandlers,
): void {
  el.classList.add("roost-card-ready");
  el.style.minHeight = "";
  const shimmer = el.querySelector(".roost-shimmer");
  if (shimmer) shimmer.remove();
  el.addEventListener("animationend", () => {
    el.classList.remove("roost-card-placeholder");
  }, { once: true });
  el.dataset.path = entry.file.path;

  const platformVal = safeGetValue(entry, "note.platform");
  if (platformVal) el.dataset.platform = platformVal.toString();
  const catVal = safeGetValue(entry, `note.${CATEGORY_FIELD}`);
  if (catVal) el.dataset.category = catVal.toString();

  const roostIdVal = safeGetValue(entry, "note.roost_id")?.toString();
  if (roostIdVal) el.dataset.roostId = roostIdVal;

  if (roostIdVal && handlers.uncertainRoostIds?.has(roostIdVal)) {
    el.classList.add("roost-card-uncertain");
  }

  const isMatched = roostIdVal && handlers.matchedRoostIds?.has(roostIdVal);
  if (isMatched) {
    el.dataset.matched = "1";
  }

  el.addEventListener("click", (e) => {
    if (handlers.isSelectionActive() && roostIdVal) {
      e.stopPropagation();
      handlers.onSelectionToggle(roostIdVal, el);
      return;
    }
    if (handlers.viewMode === "feed" && roostIdVal) {
      e.stopPropagation();
      handlers.onFeedSelect(roostIdVal);
      return;
    }
    if (handlers.expandState.expandedEl === el) return;
    e.stopPropagation();
    handlers.onExpand(el, entry);
  });

  if (handlers.isSelectionActive() && roostIdVal && handlers.isSelected(roostIdVal)) {
    el.classList.add("roost-card-selected");
  }

  const coverEl = el.createDiv({ cls: "roost-card-cover" });
  coverEl.style.cssText = `aspect-ratio: 1 / ${cfg.imageRatio}; position: relative;`;

  if (isMatched) {
    const matchDetail = roostIdVal ? handlers.matchDetailMap?.get(roostIdVal) : null;
    const score = matchDetail?.score;
    coverEl.createDiv({
      cls: "roost-card-match-badge",
      text: score ? `Match ${score}/10` : "Matched",
    });
  }

  // Text-only tweets whose body is now backfilled into the note render as a
  // text tile rather than the redundant generated card.png. A real video
  // (poster cover) still wins — that's genuine media, not a text card.
  const isTextTile = handlers.isTextTileCover(entry) && !handlers.resolveVideoUrl(entry);
  const imageUrl = isTextTile ? null : handlers.resolveImageUrl(entry, cfg.imagePropId);
  if (isTextTile) {
    renderTextTileCover(coverEl, entry);
  } else if (imageUrl) {
    const img = coverEl.createEl("img");
    img.style.cssText = `width: 100%; height: 100%; object-fit: ${cfg.imageFit}; display: block;`;
    img.src = imageUrl;
    img.alt = "";

    const videoUrl = handlers.resolveVideoUrl(entry);
    if (videoUrl) {
      setupGalleryVideoScrub(coverEl, videoUrl);
      const ext = videoUrl.match(/\.(\w+)(?:\?|$)/)?.[1]?.toUpperCase();
      if (ext) {
        const badge = coverEl.createDiv({ cls: "roost-card-badge" });
        badge.textContent = ext;
      }
    } else if (handlers.hasMultipleImages(entry)) {
      const badge = coverEl.createDiv({ cls: "roost-card-badge" });
      badge.textContent = "📷+";
    }
  } else {
    const platform = safeGetValue(entry, "note.platform")?.toString() ?? "";
    coverEl.style.cssText += `
        background: var(--background-secondary);
        display: flex; align-items: center; justify-content: center;
      `;
    const iconEl = coverEl.createDiv();
    iconEl.style.cssText = "color: var(--text-muted); opacity: 0.3;";
    setIcon(iconEl, platform === "tiktok" ? "music" : platform === "twitter" ? "message-square" : "bookmark");
  }

  if (roostIdVal) {
    const pipelineHit = getPipelineData(roostIdVal);
    if (pipelineHit) {
      renderPipelineOverlay(coverEl, pipelineHit.type);
    }
  }

  const body = el.createDiv({ cls: "roost-card-body" });

  // Text tiles already show the tweet text (and author) in the cover area —
  // skip the duplicate title line here so the body carries only meta/chips.
  if (!isTextTile) {
    const titleValue = safeGetValue(entry, "note.title");
    const rawTitle = titleValue?.toString() ?? entry.file.basename;
    const title = cleanCaption(rawTitle) || entry.file.basename;
    const titleEl = body.createDiv({ cls: "roost-card-title" });
    titleEl.textContent = title;
    if (title !== rawTitle) titleEl.title = rawTitle;
  }

  const meta = body.createDiv({ cls: "roost-card-meta" });

  if (cfg.showAuthor && !isTextTile) {
    const authorValue = safeGetValue(entry, "note.author");
    if (authorValue) {
      const authorEl = meta.createSpan({ cls: "roost-card-author" });
      authorEl.textContent = authorValue.toString().replace(/\[\[People\/|\]\]/g, "");
    }
  }

  if (cfg.showPlatform) {
    const platformValue = safeGetValue(entry, "note.platform");
    if (platformValue) {
      const platformEl = meta.createSpan({
        cls: `roost-card-platform roost-platform-${platformValue.toString()}`,
      });
      platformEl.textContent = platformValue.toString();
    }
  }

  if (cfg.showTags) {
    const tagsValue = safeGetValue(entry, "note.tags");
    if (tagsValue) {
      const tagsEl = body.createDiv({ cls: "roost-card-tags" });
      const tagStr = tagsValue.toString();
      const tags = tagStr.split(",").map(t => t.trim()).filter(t => {
        if (!t) return false;
        const lower = t.toLowerCase();
        return !t.startsWith("collection/") && lower !== "tiktok" && lower !== "twitter" && lower !== "original sound";
      });
      for (const tag of tags.slice(0, 4)) {
        const pill = tagsEl.createSpan({ cls: "roost-card-tag" });
        pill.textContent = tag.startsWith("#") ? tag : `#${tag}`;
      }
    }
  }

  if (roostIdVal) {
    const chipRow = body.createDiv({ cls: "roost-chip-row" });
    let chipsRendered = 0;
    for (const enrichment of ENRICHMENTS) {
      if (!enrichment.chips?.length) continue;
      const versionField = `enrichment_v_${enrichment.id}`;
      const versionValue = safeGetValue(entry, `note.${versionField}`);
      let hasVersion = versionValue != null && versionValue !== "";
      if (!hasVersion && enrichment.legacyAliases) {
        for (const alias of enrichment.legacyAliases) {
          const v = safeGetValue(entry, `note.${alias}`);
          if (v != null && v !== "") { hasVersion = true; break; }
        }
      }
      if (!hasVersion) continue;
      for (const chip of enrichment.chips) {
        const fieldValue = safeGetValue(entry, `note.${chip.field}`);
        renderChip(chipRow, { kind: chip.kind, value: fieldValue as string | number | null | undefined });
        chipsRendered++;
      }
    }
    if (chipsRendered === 0) chipRow.remove();
  }
}

export interface SyncGalleryCardOpts {
  uncertainRoostIds?: Set<string> | null;
  matchedRoostIds?: Set<string> | null;
  matchDetailMap?: Map<string, MatchDetail> | null;
}

/** Refresh metadata-dependent fields on a kept hydrated card after reconcile. */
export function syncGalleryCardFromEntry(
  el: HTMLElement,
  entry: BasesEntry,
  opts?: SyncGalleryCardOpts,
): void {
  const catVal = safeGetValue(entry, `note.${CATEGORY_FIELD}`)?.toString();
  if (catVal) el.dataset.category = catVal;
  else delete el.dataset.category;

  const platformVal = safeGetValue(entry, "note.platform")?.toString();
  if (platformVal) el.dataset.platform = platformVal;
  else delete el.dataset.platform;

  const roostId = safeGetValue(entry, "note.roost_id")?.toString();
  if (!roostId) return;

  const uncertain = opts?.uncertainRoostIds?.has(roostId) ?? false;
  el.classList.toggle("roost-card-uncertain", uncertain);

  const matched = opts?.matchedRoostIds?.has(roostId) ?? false;
  if (matched) el.dataset.matched = "1";
  else delete el.dataset.matched;

  const coverEl = el.querySelector(".roost-card-cover");
  if (!coverEl) return;

  const existingBadge = coverEl.querySelector(".roost-card-match-badge");
  if (matched) {
    const score = opts?.matchDetailMap?.get(roostId)?.score;
    const badge = existingBadge ?? coverEl.createDiv({ cls: "roost-card-match-badge" });
    badge.textContent = score ? `Match ${score}/10` : "Matched";
  } else if (existingBadge) {
    existingBadge.remove();
  }
}
