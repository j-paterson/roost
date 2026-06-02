/**
 * Shared expanded-card renderer — vanilla DOM so it works in both
 * the gallery (BasesView, vanilla) and review modal (React via ref).
 *
 * Produces the same `.roost-expanded-*` DOM structure styled by bases-view.css.
 */

import { splitCaption } from "@/lib/caption";
import { splitParagraphs, tokenizeRuns } from "@/sync/card-renderer";

export interface BodySegment {
  text: string;
  isFocal?: boolean;
  /** Resolved resource paths for inline photos belonging to this segment. */
  photoUrls?: string[];
}

export interface ExpandedCardData {
  title: string;
  videoUrl?: string | null;
  allImageUrls?: string[];
  coverUrl?: string | null;
  platform?: string | null;
  author?: string | null;
  stats?: { plays?: number; likes?: number; comments?: number; shares?: number };
  tags?: string[];
  url?: string | null;
  /** 1-based page to open on when multi-image — used by threaded tweets to land on the bookmarked tweet. */
  startIndex?: number | null;
  /** Structured body content for text-only items + threaded bookmarks.
   *  Each segment renders its text (paragraph-split + entity-styled) followed
   *  by an inline photo grid for any per-segment images. Dividers between
   *  segments. For non-threaded text bodies, pass a single-element array. */
  bodySegments?: BodySegment[];
  /** Extra elements appended at the end of the info pane (e.g. "Open note →"). */
  extraEls?: HTMLElement[];
}

function formatStat(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const STAT_ICONS: Record<string, string> = {
  plays: "\u25B6",
  likes: "\u2665",
  comments: String.fromCodePoint(0x1F4AC),
  shares: "\u2197",
};

// Brand glyphs — paths from simple-icons, drawn in currentColor so we can
// tint them with CSS. viewBox 0 0 24 24.
const PLATFORM_LOGOS: Record<string, string> = {
  tiktok:
    '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path fill="currentColor" d="M19.589 6.686a4.793 4.793 0 0 1-3.77-4.245V2h-3.445v13.672a2.896 2.896 0 0 1-5.201 1.743l-.002-.001.002.001a2.895 2.895 0 0 1 3.183-4.51v-3.5a6.329 6.329 0 0 0-5.394 10.692 6.33 6.33 0 0 0 10.857-4.424V8.687a8.182 8.182 0 0 0 4.773 1.526V6.79a4.831 4.831 0 0 1-1.003-.104z"/>' +
    "</svg>",
  twitter:
    '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>' +
    "</svg>",
  x:
    '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>' +
    "</svg>",
};

/**
 * Render an expanded card into `container`.
 * Returns a cleanup function (pauses video, etc.).
 */
export function renderExpandedCard(
  container: HTMLElement,
  data: ExpandedCardData,
): () => void {
  container.empty();

  const hasMedia = Boolean(
    data.videoUrl ||
      (data.allImageUrls && data.allImageUrls.length > 0) ||
      data.coverUrl,
  );
  if (!hasMedia) container.addClass("roost-expanded-text-only");
  const segments = data.bodySegments?.filter((s) => s.text && s.text.trim()) ?? [];
  const hasBodyText = segments.length > 0;
  if (hasBodyText) container.addClass("roost-expanded-has-bodytext");

  // ── Left: media panel (omitted entirely for text-only items) ──
  const mediaEl = hasMedia
    ? container.createDiv({ cls: "roost-expanded-media" })
    : null;
  let videoEl: HTMLVideoElement | null = null;

  if (mediaEl && data.videoUrl) {
    videoEl = document.createElement("video");
    videoEl.src = data.videoUrl;
    videoEl.controls = true;
    videoEl.muted = true;
    videoEl.autoplay = true;
    videoEl.loop = true;
    videoEl.playsInline = true;
    videoEl.preload = "auto";
    videoEl.className = "roost-expanded-video";
    mediaEl.appendChild(videoEl);
  } else if (mediaEl && data.allImageUrls && data.allImageUrls.length > 1) {
    // Multi-image carousel
    const allImages = data.allImageUrls;
    const start = data.startIndex && data.startIndex >= 1 && data.startIndex <= allImages.length
      ? data.startIndex - 1
      : 0;
    let currentIdx = start;
    const img = mediaEl.createEl("img", { cls: "roost-expanded-img" });
    img.src = allImages[currentIdx];

    const prevBtn = mediaEl.createDiv({ cls: "roost-gallery-btn roost-gallery-btn-prev", text: "\u2039" });
    const nextBtn = mediaEl.createDiv({ cls: "roost-gallery-btn roost-gallery-btn-next", text: "\u203A" });
    const counter = mediaEl.createEl("span", { cls: "roost-gallery-counter", text: `${currentIdx + 1} / ${allImages.length}` });

    const update = () => {
      img.src = allImages[currentIdx];
      counter.textContent = `${currentIdx + 1} / ${allImages.length}`;
    };

    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      currentIdx = (currentIdx - 1 + allImages.length) % allImages.length;
      update();
    });
    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      currentIdx = (currentIdx + 1) % allImages.length;
      update();
    });
  } else if (mediaEl && data.coverUrl) {
    const img = mediaEl.createEl("img", { cls: "roost-expanded-img" });
    img.src = data.coverUrl;
  }

  // ── Right: info panel ──
  const info = container.createDiv({ cls: "roost-expanded-info" });

  // Title — split raw caption into a short title and an optional description.
  // When bodyText is being rendered we already show the full content below,
  // so the "…" expand toggle would just duplicate it — skip in that case.
  const { title, description } = splitCaption(data.title);
  const header = info.createDiv({ cls: "roost-expanded-header" });
  const titleEl = header.createDiv({ cls: "roost-expanded-title" });
  titleEl.createSpan({ cls: "roost-expanded-title-text", text: title || data.title });
  if (description && !hasBodyText) {
    const toggle = titleEl.createSpan({ cls: "roost-expanded-title-toggle", text: "…" });
    toggle.setAttr("role", "button");
    toggle.setAttr("aria-label", "Show full description");
    toggle.setAttr("title", "Show full description");
    const body = info.createDiv({ cls: "roost-expanded-body roost-expanded-body-collapsed", text: description });
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const expanded = body.classList.toggle("roost-expanded-body-collapsed") === false;
      toggle.setAttr("aria-label", expanded ? "Hide description" : "Show full description");
      toggle.setAttr("title", expanded ? "Hide description" : "Show full description");
    });
  }

  // Identity: @author (linked to URL if present) + platform dot
  if (data.author || data.platform || data.url) {
    const identity = info.createDiv({ cls: "roost-expanded-identity" });
    if (data.platform) {
      const dot = identity.createEl("span", { cls: `roost-expanded-identity-dot roost-platform-${data.platform}` });
      dot.setAttr("title", data.platform);
      const logo = PLATFORM_LOGOS[data.platform];
      // logo is a trusted in-repo SVG constant (not user/network data — see PLATFORM_LOGOS above)
      if (logo) dot.innerHTML = logo;
    }
    const handle = data.author ? `@${data.author.replace(/^@/, "")}` : data.url;
    if (handle) {
      if (data.url) {
        const link = identity.createEl("a", { cls: "roost-expanded-identity-handle", text: handle, href: data.url });
        link.addEventListener("click", (e) => { e.preventDefault(); window.open(data.url!, "_blank"); });
      } else {
        identity.createEl("span", { cls: "roost-expanded-identity-handle", text: handle });
      }
    }
  }

  // Structured body content — each segment renders its text (paragraph-split
  // + entity-styled) followed by an inline photo grid. Dividers between.
  if (hasBodyText) {
    const bodyEl = info.createDiv({ cls: "roost-expanded-bodytext" });
    segments.forEach((seg, segIdx) => {
      const segEl = bodyEl.createDiv({ cls: "roost-expanded-bodytext-segment" });
      if (seg.isFocal) segEl.addClass("roost-expanded-bodytext-focal");

      // Text paragraphs go in their own column wrapper so they stack
      // vertically alongside the photo grid (segment itself is flex-row).
      const textCol = segEl.createDiv({ cls: "roost-expanded-bodytext-text" });
      for (const para of splitParagraphs(seg.text)) {
        const p = textCol.createDiv({ cls: "roost-expanded-bodytext-para" });
        const lines = para.split("\n");
        lines.forEach((line, i) => {
          if (i > 0) p.createEl("br");
          for (const run of tokenizeRuns(line)) {
            const span = p.createEl("span");
            span.textContent = run.text;
            if (run.color) span.style.color = run.color;
          }
        });
      }

      if (seg.photoUrls && seg.photoUrls.length > 0) {
        const photos = segEl.createDiv({
          cls: `roost-expanded-bodytext-photos roost-photo-grid-${Math.min(seg.photoUrls.length, 4)}`,
        });
        for (const url of seg.photoUrls) {
          const img = photos.createEl("img", { cls: "roost-expanded-bodytext-photo" });
          img.src = url;
          img.loading = "lazy";
        }
      }

      if (segIdx < segments.length - 1) {
        bodyEl.createDiv({
          cls: "roost-expanded-bodytext-divider",
          attr: { "aria-hidden": "true" },
        });
      }
    });
  }

  // Stats (icon + value)
  if (data.stats) {
    const statsRow = info.createDiv({ cls: "roost-expanded-stats" });
    for (const [key, val] of Object.entries(data.stats)) {
      if (!val || !isFinite(val) || val === 0) continue;
      const stat = statsRow.createDiv({ cls: "roost-expanded-stat" });
      stat.createEl("span", { cls: "roost-expanded-stat-icon", text: STAT_ICONS[key] ?? "•" });
      stat.createEl("span", { cls: "roost-expanded-stat-val", text: formatStat(val) });
    }
  }

  // Tags
  if (data.tags && data.tags.length > 0) {
    const tagsEl = info.createDiv({ cls: "roost-expanded-tags" });
    for (const tag of data.tags) {
      if (!tag) continue;
      const lower = tag.toLowerCase();
      if (tag.startsWith("collection/") || lower === "tiktok" || lower === "twitter" || lower === "original sound") continue;
      tagsEl.createEl("span", { cls: "roost-card-tag", text: tag.startsWith("#") ? tag : `#${tag}` });
    }
  }

  // Extra elements (caller-provided)
  if (data.extraEls) {
    for (const el of data.extraEls) info.appendChild(el);
  }

  // Show a bottom fade-out gradient when the info panel is actually
  // scrollable AND the user hasn't scrolled to the bottom. Acts as a "more
  // below" hint for long threads. We measure after a frame so layout has
  // resolved (images/embeds in the info pane affect scrollHeight).
  const updateOverflow = (): void => {
    if (!hasBodyText) return;
    const overflows = info.scrollHeight > info.clientHeight + 1;
    const atBottom =
      Math.ceil(info.scrollTop + info.clientHeight) >= info.scrollHeight - 1;
    container.toggleClass("roost-expanded-overflow", overflows && !atBottom);
  };
  const rafId = requestAnimationFrame(updateOverflow);
  info.addEventListener("scroll", updateOverflow, { passive: true });
  const resizeObserver =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(updateOverflow)
      : null;
  resizeObserver?.observe(info);

  return () => {
    if (videoEl) { videoEl.pause(); videoEl.src = ""; }
    cancelAnimationFrame(rafId);
    info.removeEventListener("scroll", updateOverflow);
    resizeObserver?.disconnect();
  };
}
