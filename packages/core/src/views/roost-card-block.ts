/**
 * `roost-card` code block processor.
 *
 * A digest can embed any bookmark note as a real expanded card via:
 *
 *     ```roost-card
 *     Bookmarks/X/Unknown - 2050318038843486682
 *     ```
 *
 * The block content is a vault-relative note path (with or without ".md").
 * On render, we look up the file's frontmatter and feed it into the shared
 * `renderExpandedCard` so the digest gets the same DOM/CSS as the gallery's
 * expanded card. Clicking anywhere on the card opens the source note.
 */

import {
  type App,
  MarkdownRenderChild,
  type Plugin,
  TFile,
} from "obsidian";
import { animate } from "motion";
import { renderExpandedCard } from "@/ui/components/expanded-card";
import {
  digestCardContext,
  digestMediaResolvers,
  entryToExpandedCardData,
  frontmatterBasesEntry,
} from "@/views/entry-to-expanded-card";

/** Decode the HTML entities Twitter injects into tweet text. */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

interface ThreadSegment {
  text?: string;
  isFocal?: boolean;
  /** Numbered page files in the attach folder that belong to this segment.
   *  Each entry is a 1-indexed page number; the actual file is either
   *  `{N}.jpg` (real photo) or `{N}.png` (rasterized text card). */
  pages?: number[];
}

interface ThreadJson {
  focalIndex?: number;
  segments?: ThreadSegment[];
}

interface ResolvedSegment {
  text: string;
  isFocal: boolean;
  photoUrls: string[];
}

/** Heuristic: identify thread segments that are actually external replies
 *  (the author replied to *another user* in the same conversation, not to
 *  themselves). When a segment's leading @-handle is not the OP author,
 *  it's noise — those got bundled in because extractThread only filtered
 *  by author+conversation_id, not by reply target. Skipping them gives
 *  a clean self-thread view even for legacy thread.json files. */
function isExternalReplySegment(text: string, opAuthor: string | null): boolean {
  if (!opAuthor) return false;
  const m = text.match(/^@(\w+)/);
  if (!m) return false;
  return m[1].toLowerCase() !== opAuthor.replace(/^@/, "").toLowerCase();
}

/** Resolve a segment's `pages` array to inline-photo resource paths. Only
 *  `{N}.jpg` files count as real photos — `{N}.png` files are rasterized
 *  text cards whose content is already rendered inline. */
function resolveSegmentPhotos(
  app: App,
  attachFolder: string,
  pages: number[] | undefined,
): string[] {
  if (!pages || pages.length === 0 || !attachFolder) return [];
  const out: string[] = [];
  for (const n of pages) {
    const jpg = app.vault.getAbstractFileByPath(`${attachFolder}/${n}.jpg`);
    if (jpg instanceof TFile) out.push(app.vault.getResourcePath(jpg));
  }
  return out;
}

/** Pull renderable body content as a list of structured segments:
 *  - threaded: each self-thread segment becomes {text, isFocal, photoUrls}.
 *    External replies (author replying to other users) are filtered out.
 *  - text-only non-threaded: single segment with the note body.
 *  Returns an empty array when no useful text is available. */
async function loadBodySegments(
  app: App,
  file: TFile,
  attachFolder: string,
  opAuthor: string | null,
): Promise<ResolvedSegment[]> {
  if (attachFolder) {
    const threadFile = app.vault.getAbstractFileByPath(`${attachFolder}/thread.json`);
    if (threadFile instanceof TFile) {
      try {
        const parsed = JSON.parse(
          await app.vault.cachedRead(threadFile),
        ) as ThreadJson;
        const segs = Array.isArray(parsed.segments) ? parsed.segments : [];
        const hasFocalFlag = segs.some((s) => s?.isFocal === true);
        const focalIdx =
          typeof parsed.focalIndex === "number" ? parsed.focalIndex : 0;
        const out: ResolvedSegment[] = [];
        segs.forEach((seg, i) => {
          if (!seg?.text) return;
          const isFocal = hasFocalFlag ? seg.isFocal === true : i === focalIdx;
          if (!isFocal && isExternalReplySegment(seg.text, opAuthor)) return;
          out.push({
            text: decodeHtmlEntities(seg.text),
            isFocal,
            photoUrls: resolveSegmentPhotos(app, attachFolder, seg.pages),
          });
        });
        if (out.length > 0) return out;
      } catch {
        // fall through
      }
    }
  }
  const raw = await app.vault.cachedRead(file);
  const body = stripFrontmatter(raw)
    .replace(/!\[\[[^\]]+\]\]/g, "")
    .trim();
  if (!body) return [];
  return [{ text: decodeHtmlEntities(body), isFocal: true, photoUrls: [] }];
}

/** Strip the YAML frontmatter block from a markdown file's contents. */
function stripFrontmatter(raw: string): string {
  return raw.replace(/^---[\s\S]*?\n---\n?/, "").trim();
}

/**
 * Lazy-mount a video element inside the card's `.roost-expanded-media` pane
 * when the card scrolls into the viewport (rootMargin 200px), and tear it
 * down when it scrolls out. Hides any existing media children (the cover
 * image or carousel) while the video is mounted, and restores them on unmount.
 *
 * Prevents 50+ digest cards from all spinning up `<video>` decoders at once.
 */
function attachLazyVideo(card: HTMLElement, videoUrl: string): () => void {
  const mediaEl = card.querySelector(
    ".roost-expanded-media",
  ) as HTMLElement | null;
  if (!mediaEl) return () => {};

  let videoEl: HTMLVideoElement | null = null;

  const mount = (): void => {
    if (videoEl) return;
    for (const child of Array.from(mediaEl.children)) {
      (child as HTMLElement).style.display = "none";
    }
    videoEl = document.createElement("video");
    videoEl.src = videoUrl;
    videoEl.controls = true;
    videoEl.muted = true;
    videoEl.autoplay = true;
    videoEl.loop = true;
    videoEl.playsInline = true;
    videoEl.preload = "metadata";
    videoEl.className = "roost-expanded-video";
    mediaEl.appendChild(videoEl);
  };

  const unmount = (): void => {
    if (!videoEl) return;
    videoEl.pause();
    videoEl.src = "";
    videoEl.remove();
    videoEl = null;
    for (const child of Array.from(mediaEl.children)) {
      (child as HTMLElement).style.display = "";
    }
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) mount();
        else unmount();
      }
    },
    { rootMargin: "200px" },
  );
  observer.observe(card);

  return () => {
    observer.disconnect();
    unmount();
  };
}

/**
 * Mount a click delegate on the card that opens a lightbox overlay when an
 * inline photo (or top-panel cover image) is clicked. The overlay is a
 * child of the card itself (position: absolute, inset: 0) so it stays
 * "within" the card.
 *
 * Open animation: FLIP — the enlarged image starts at the source image's
 * on-screen rect and springs into its maximized position. Close reverses.
 *
 * Closes on ESC, backdrop click, or click on the enlarged image. Returns
 * a cleanup that removes any open overlay + listeners.
 */
function attachImageLightbox(card: HTMLElement): () => void {
  let overlay: HTMLElement | null = null;
  let sourceImg: HTMLImageElement | null = null;
  let closing = false;

  const SPRING = { type: "spring" as const, stiffness: 320, damping: 32 };

  const removeOverlay = (): void => {
    overlay?.remove();
    overlay = null;
    sourceImg = null;
    closing = false;
    document.removeEventListener("keydown", onKey, true);
  };

  const close = (): void => {
    if (!overlay || closing) return;
    closing = true;
    const enlarged = overlay.querySelector(
      "img.roost-card-image-lightbox-img",
    ) as HTMLImageElement | null;

    const target = sourceImg?.getBoundingClientRect();
    const current = enlarged?.getBoundingClientRect();

    if (!enlarged || !target || !current || target.width === 0 || current.width === 0) {
      removeOverlay();
      return;
    }

    const dx = target.left - current.left;
    const dy = target.top - current.top;
    const sw = target.width / current.width;
    const sh = target.height / current.height;

    if (![dx, dy, sw, sh].every(Number.isFinite)) {
      removeOverlay();
      return;
    }

    // Backdrop fades out in parallel with image shrinking.
    animate(overlay, { opacity: [1, 0] }, { duration: 0.22 });
    animate(
      enlarged,
      { x: [0, dx], y: [0, dy], scaleX: [1, sw], scaleY: [1, sh] },
      SPRING,
    ).finished.then(removeOverlay).catch(removeOverlay);
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && overlay) {
      e.stopPropagation();
      close();
    }
  };

  const onClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest(".roost-gallery-btn")) return;

    // Click while overlay is open → close (no matter where).
    if (overlay && overlay.contains(target)) {
      e.stopPropagation();
      close();
      return;
    }

    const img = target.closest(
      "img.roost-expanded-bodytext-photo, img.roost-expanded-img",
    ) as HTMLImageElement | null;
    if (!img || !img.src) return;

    e.preventDefault();
    e.stopPropagation();

    // FLIP open: capture FIRST (source image rect), mount overlay, capture
    // LAST (enlarged target rect), then animate from FIRST → LAST.
    const first = img.getBoundingClientRect();
    sourceImg = img;
    overlay = card.createDiv({ cls: "roost-card-image-lightbox" });
    overlay.style.opacity = "0";
    const enlarged = overlay.createEl("img", {
      cls: "roost-card-image-lightbox-img",
    });
    enlarged.src = img.src;

    requestAnimationFrame(() => {
      if (!overlay || !enlarged.isConnected) return;
      const last = enlarged.getBoundingClientRect();
      if (last.width === 0 || last.height === 0) {
        overlay.style.opacity = "1";
        return;
      }
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      const sw = first.width / last.width;
      const sh = first.height / last.height;

      animate(overlay, { opacity: [0, 1] }, { duration: 0.18 });
      if ([dx, dy, sw, sh].every(Number.isFinite)) {
        animate(
          enlarged,
          { x: [dx, 0], y: [dy, 0], scaleX: [sw, 1], scaleY: [sh, 1] },
          SPRING,
        );
      }
    });

    document.addEventListener("keydown", onKey, true);
  };

  card.addEventListener("click", onClick);

  return () => {
    card.removeEventListener("click", onClick);
    removeOverlay();
  };
}

class RoostCardBlockChild extends MarkdownRenderChild {
  constructor(containerEl: HTMLElement, private cleanup: () => void) {
    super(containerEl);
  }
  onunload(): void {
    this.cleanup();
  }
}

function showError(el: HTMLElement, msg: string): void {
  el.createDiv({ cls: "roost-card-block-error", text: `[roost-card] ${msg}` });
}

export function registerRoostCardBlock(plugin: Plugin): void {
  plugin.registerMarkdownCodeBlockProcessor(
    "roost-card",
    async (source, el, ctx) => {
      const raw = source.trim();
      if (!raw) {
        showError(el, "missing note path");
        return;
      }

      const path = raw.endsWith(".md") ? raw : `${raw}.md`;
      const file = plugin.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        showError(el, `not found: ${raw}`);
        return;
      }

      const cache = plugin.app.metadataCache.getFileCache(file);
      if (!cache?.frontmatter) {
        showError(el, `no frontmatter: ${raw}`);
        return;
      }

      const fm = cache.frontmatter as Record<string, unknown>;
      const entry = frontmatterBasesEntry(file, fm);
      const resolvers = digestMediaResolvers(plugin.app);
      const digestCtx = digestCardContext(plugin.app, entry, resolvers);
      const expanded = entryToExpandedCardData(entry, resolvers);

      // Load structured body content: per-segment text + inline photos for
      // threaded bookmarks; single-segment note body for plain text-only.
      let bodySegments: ResolvedSegment[] = [];
      if (digestCtx.hasTextBody) {
        bodySegments = await loadBodySegments(
          plugin.app,
          file,
          digestCtx.attachFolder,
          expanded.author ?? null,
        );
      }

      // When body segments contain inline photos, those photos already
      // appear next to their text — don't double them up in the top media
      // panel. Top panel keeps video lazy-hydration; static cover is dropped.
      const inlinePhotosPresent = bodySegments.some(
        (s) => s.photoUrls && s.photoUrls.length > 0,
      );
      const topCoverUrl =
        digestCtx.hideMediaPanel || inlinePhotosPresent ? null : expanded.coverUrl;
      const topImageUrls =
        !digestCtx.hideMediaPanel &&
        !inlinePhotosPresent &&
        (expanded.allImageUrls?.length ?? 0) > 1
          ? expanded.allImageUrls
          : undefined;

      const card = el.createDiv({ cls: "roost-card-block roost-expanded" });
      const { stats: _stats, startIndex: _startIndex, extraEls: _extra, ...digestCard } =
        expanded;
      const cleanup = renderExpandedCard(card, {
        ...digestCard,
        coverUrl: topCoverUrl,
        // Multi-image carousels render eagerly (image loads are cheap and
        // the carousel arrows are user-driven). Video is deferred until
        // the card scrolls into view to avoid spinning up many decoders.
        allImageUrls: topImageUrls,
        bodySegments: bodySegments.length > 0 ? bodySegments : undefined,
      });

      const videoCleanup =
        !digestCtx.hideMediaPanel && expanded.videoUrl
          ? attachLazyVideo(card, expanded.videoUrl)
          : null;

      // Click on any inline photo (or the top-panel cover/carousel image)
      // opens a lightbox overlaid on the card. Carousel next/prev buttons
      // keep their navigation behavior.
      const modalCleanup = attachImageLightbox(card);

      ctx.addChild(
        new RoostCardBlockChild(el, () => {
          modalCleanup();
          videoCleanup?.();
          cleanup();
        }),
      );
    },
  );
}
