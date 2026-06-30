/**
 * Explorer expanded card panel — media preview + metadata props.
 */
import type { App, BasesEntry, MarkdownRenderChild } from "obsidian";
import { MarkdownRenderer } from "obsidian";
import { safeGetValue, getNoteTitle } from "@/lib/bases-entry";
import { stripFrontmatter } from "@/lib/vault-utils";
import { ContentType, detectContentType, extractDomain, hasValue } from "@/views/content-detector";
import { EXPLORER_RICH_FIELDS, EXPLORER_SKIP_PROPS } from "@/views/explorer-view-options";
import type { ExplorerCardConfig } from "@/views/explorer-hydrate-card";
import { renderLinkCard } from "@/views/link-card-renderer";

export interface ExplorerExpandedHost {
  app: App;
  cfg: ExplorerCardConfig;
  resolveEntryImageUrl(entry: BasesEntry, propId: string): string | null;
  resolveImageUrl(entry: BasesEntry, propId: string): string | null;
  getPropertyIds(): string[] | undefined;
  getDisplayName(propId: string): string;
  closeExpanded(): void;
  markdownRenderChild: MarkdownRenderChild;
}

export function renderExplorerExpandedPanel(
  cardEl: HTMLElement,
  entry: BasesEntry,
  host: ExplorerExpandedHost,
): void {
  const contentType = detectContentType(entry, host.app);
  const mediaEl = cardEl.createDiv({ cls: "roost-expanded-media" });

  switch (contentType) {
    case ContentType.Bookmark:
    case ContentType.Media: {
      const imageUrl = host.resolveEntryImageUrl(entry, host.cfg.imagePropId);
      if (imageUrl) {
        const img = mediaEl.createEl("img");
        img.src = imageUrl;
        img.className = "roost-expanded-img";
      } else {
        mediaEl.createDiv({ cls: "roost-expanded-placeholder", text: "No preview" });
      }
      break;
    }

    case ContentType.Link: {
      const imageUrl = host.resolveImageUrl(entry, host.cfg.imagePropId);
      if (imageUrl) {
        const img = mediaEl.createEl("img");
        img.src = imageUrl;
        img.className = "roost-expanded-img";
      }
      const url = safeGetValue(entry, "note.url")?.toString();
      if (url) {
        const linkBox = mediaEl.createDiv({ cls: "roost-expanded-link-box" });
        linkBox.createDiv({ cls: "roost-expanded-link-domain", text: extractDomain(url) });
        const openBtn = linkBox.createEl("a", {
          cls: "roost-expanded-link-open",
          text: "Open in browser →",
          href: url,
        });
        openBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          window.open(url, "_blank");
        });
      }
      break;
    }

    case ContentType.Note: {
      const mdContainer = mediaEl.createDiv({ cls: "roost-expanded-markdown" });
      void host.app.vault.cachedRead(entry.file).then(content => {
        MarkdownRenderer.render(
          host.app,
          stripFrontmatter(content),
          mdContainer,
          entry.file.path,
          host.markdownRenderChild,
        );
      });
      break;
    }
  }

  const info = cardEl.createDiv({ cls: "roost-expanded-info" });
  const header = info.createDiv({ cls: "roost-expanded-header" });
  header.createDiv({ cls: "roost-expanded-title", text: getNoteTitle(entry) });
  const closeBtn = header.createDiv({ cls: "roost-expanded-close", text: "✕" });
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    host.closeExpanded();
  });

  for (const { id: fieldId, kind } of EXPLORER_RICH_FIELDS) {
    const val = safeGetValue(entry, fieldId);
    if (!hasValue(val)) continue;
    const valStr = String(val);
    const label = fieldId.replace("note.", "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    const block = info.createDiv({ cls: "roost-expanded-rich-block" });
    block.createDiv({ cls: "roost-expanded-rich-label", text: label });
    if (kind === "quote") {
      block.createEl("blockquote", { cls: "roost-expanded-quote", text: valStr });
    } else {
      block.createDiv({ cls: "roost-expanded-rich-text", text: valStr });
    }
  }

  const props = host.getPropertyIds();
  if (props?.length) {
    const propsEl = info.createDiv({ cls: "roost-expanded-props" });
    for (const propId of props) {
      if (propId.startsWith("file.")) continue;
      if (EXPLORER_SKIP_PROPS.has(propId)) continue;
      const val = safeGetValue(entry, propId);
      if (!hasValue(val)) continue;
      const row = propsEl.createDiv({ cls: "roost-expanded-prop" });
      row.createSpan({ cls: "roost-expanded-prop-key", text: host.getDisplayName(propId) });
      row.createSpan({ cls: "roost-expanded-prop-val", text: String(val) });
    }
  }

  const tagsRaw = safeGetValue(entry, "note.tags");
  if (hasValue(tagsRaw)) {
    const tagsEl = info.createDiv({ cls: "roost-expanded-tags" });
    const tags = String(tagsRaw)
      .split(",")
      .map(t => t.trim())
      .filter(t => t && t !== "null" && t !== "undefined");
    for (const tag of tags) {
      tagsEl.createSpan({
        cls: "roost-card-tag",
        text: tag.startsWith("#") ? tag : `#${tag}`,
      });
    }
  }

  // When note.link_url is present, render the rich link card (compact) instead of a bare
  // anchor. Keep the bare-<a> path only as fallback for a generic note.url field.
  const linkUrlRaw = safeGetValue(entry, "note.link_url")?.toString();
  if (linkUrlRaw) {
    renderLinkCard(info, {
      url: linkUrlRaw,
      title: safeGetValue(entry, "note.link_title")?.toString(),
      description: safeGetValue(entry, "note.link_desc")?.toString(),
      site: safeGetValue(entry, "note.link_site")?.toString(),
      imageSrc: host.resolveImageUrl(entry, "note.link_image"),
    }, { compact: true });
  } else {
    const urlRaw = safeGetValue(entry, "note.url");
    const urlStr = hasValue(urlRaw) ? String(urlRaw) : null;
    if (urlStr) {
      const link = info.createEl("a", { cls: "roost-expanded-link", text: urlStr, href: urlStr });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(urlStr, "_blank");
      });
    }
  }

  const openNote = info.createDiv({ cls: "roost-expanded-open-note", text: "Open note →" });
  openNote.addEventListener("click", (e) => {
    e.stopPropagation();
    void host.app.workspace.openLinkText(entry.file.path, "", false);
  });

  info.createDiv({ cls: "roost-expanded-id", text: entry.file.path });
}
