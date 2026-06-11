/**
 * Explorer compact card hydration — content-type-aware covers and body.
 */
import type { App, BasesEntry } from "obsidian";
import { setIcon } from "obsidian";
import { safeGetValue, getNoteTitle } from "@/lib/bases-entry";
import { ContentType, detectContentType, extractDomain, hasValue } from "@/views/content-detector";
import { getExplorerExcerpt } from "@/views/explorer-excerpt";

export interface ExplorerCardConfig {
  imagePropId: string;
  imageFit: string;
  imageRatio: number;
  showPath: boolean;
}

export interface ExplorerHydrateHost {
  app: App;
  cfg: ExplorerCardConfig;
  resolveEntryImageUrl(entry: BasesEntry, propId: string): string | null;
  resolveImageUrl(entry: BasesEntry, propId: string): string | null;
}

function renderExplorerIconCover(coverEl: HTMLElement, iconName: string): void {
  coverEl.style.background = "var(--background-secondary)";
  coverEl.style.display = "flex";
  coverEl.style.alignItems = "center";
  coverEl.style.justifyContent = "center";
  const iconEl = coverEl.createDiv({ cls: "roost-card-note-icon" });
  iconEl.style.cssText = "color: var(--text-muted); opacity: 0.3;";
  setIcon(iconEl, iconName);
}

export function hydrateExplorerCard(
  el: HTMLElement,
  entry: BasesEntry,
  host: ExplorerHydrateHost,
): void {
  const contentType = detectContentType(entry, host.app);
  el.dataset.contentType = contentType;

  const { imagePropId, imageFit, imageRatio, showPath } = host.cfg;
  const coverEl = el.createDiv({ cls: "roost-card-cover" });
  coverEl.style.cssText = `aspect-ratio: 1 / ${imageRatio};`;

  switch (contentType) {
    case ContentType.Bookmark:
    case ContentType.Media: {
      const imageUrl = host.resolveEntryImageUrl(entry, imagePropId);
      if (imageUrl) {
        const img = coverEl.createEl("img");
        img.style.cssText = `width: 100%; height: 100%; object-fit: ${imageFit}; display: block;`;
        img.src = imageUrl;
        img.alt = "";
      } else {
        const ext = entry.file.extension?.toUpperCase();
        renderExplorerIconCover(
          coverEl,
          contentType === ContentType.Bookmark ? "bookmark" : "image",
        );
        if (ext) {
          coverEl.createDiv({ cls: "roost-card-badge", text: ext });
        }
      }
      if (contentType === ContentType.Bookmark) {
        const platform = safeGetValue(entry, "note.platform")?.toString();
        if (platform) {
          coverEl.createDiv({ cls: "roost-card-badge", text: platform });
        }
      }
      break;
    }

    case ContentType.Link: {
      const imageUrl = host.resolveImageUrl(entry, imagePropId);
      if (imageUrl) {
        const img = coverEl.createEl("img");
        img.style.cssText = `width: 100%; height: 100%; object-fit: ${imageFit}; display: block;`;
        img.src = imageUrl;
        img.alt = "";
      } else {
        renderExplorerIconCover(coverEl, "link");
      }
      const url = safeGetValue(entry, "note.url")?.toString();
      if (url) {
        const badge = coverEl.createDiv({ cls: "roost-card-badge roost-card-link-badge" });
        badge.textContent = extractDomain(url);
      }
      break;
    }

    case ContentType.Note: {
      const imageUrl = host.resolveImageUrl(entry, imagePropId);
      if (imageUrl) {
        const img = coverEl.createEl("img");
        img.style.cssText = `width: 100%; height: 100%; object-fit: ${imageFit}; display: block;`;
        img.src = imageUrl;
        img.alt = "";
      } else {
        coverEl.style.background = "var(--background-primary-alt)";
        coverEl.style.padding = "8px";
        coverEl.style.overflow = "hidden";
        const excerptEl = coverEl.createDiv({ cls: "roost-card-text-preview" });
        void getExplorerExcerpt(entry.file, host.app).then(text => {
          if (text) {
            excerptEl.textContent = text;
          } else {
            excerptEl.remove();
            renderExplorerIconCover(coverEl, "file-text");
          }
        });
      }
      break;
    }
  }

  const body = el.createDiv({ cls: "roost-card-body" });
  body.createDiv({ cls: "roost-card-title", text: getNoteTitle(entry) });

  if (showPath) {
    const pathEl = body.createDiv({ cls: "roost-card-path" });
    pathEl.textContent = entry.file.parent?.path ?? "";
  }

  const tagsValue = safeGetValue(entry, "note.tags");
  if (hasValue(tagsValue)) {
    const tagsEl = body.createDiv({ cls: "roost-card-tags" });
    const tags = String(tagsValue)
      .split(",")
      .map(t => t.trim())
      .filter(t => t && t !== "null" && t !== "undefined");
    for (const tag of tags.slice(0, 3)) {
      tagsEl.createSpan({
        cls: "roost-card-tag",
        text: tag.startsWith("#") ? tag : `#${tag}`,
      });
    }
  }
}
