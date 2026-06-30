/**
 * Per-platform renderers for the feed pane.
 *
 * Each renderer mounts into the supplied container and returns a handle
 * with a `dispose()` callback that releases media elements + listeners.
 * The feed panel calls dispose() when an item leaves the lazy-mount
 * window.
 */
import type { App, BasesEntry } from "obsidian";
import { renderExpandedCard } from "@/ui/components/expanded-card";
import {
  getNoteAuthor,
  getNoteTitle,
  getRoostId,
  parseEntryTags,
  safeGetValue,
} from "@/lib/bases-entry";
import {
  entryToExpandedCardData,
  type EntryMediaResolvers,
} from "@/views/entry-to-expanded-card";
import { resolveImageUrl, resolveVideoUrl, resolveAllImages } from "@/views/feed/card-helpers";
import { readGuess } from "@/views/feed/training-mode";
import { renderLinkCard } from "@/views/link-card-renderer";
import { openLinkInView } from "@/views/roost-link-view";

/** In-session mute preference shared across all TikTok feed items.
 *  Persisted only for the lifetime of the plugin process. */
let feedMuted = true;
const muteListeners = new Set<(muted: boolean) => void>();
function setFeedMuted(next: boolean) {
  if (next === feedMuted) return;
  feedMuted = next;
  for (const l of muteListeners) l(next);
}

export type FeedPlatform = "tiktok" | "x" | "default";

export interface FeedItemHandle {
  /** Called when the item is activated (snapped into view). TikTok uses it to play the video. */
  activate?: () => void;
  /** Called when the item is deactivated (another item snapped into view). */
  deactivate?: () => void;
  /** Called when the item leaves the lazy-mount window — release DOM/media. */
  dispose: () => void;
}

export interface FeedRenderContext {
  app: App;
  imagePropId: string;
  /** Wire item-action buttons to the same plugin event channel the gallery uses. */
  onAction: (action: "move" | "delete" | "open", roostId: string) => void;
  /** When true, training items render the confirm/reject action bar. */
  trainingMode?: boolean;
  /** Routes a training-mode action for an item to the host (confirm/reject/recategorize/skip). */
  onTrainingAction?: (action: "confirm" | "reject" | "recategorize" | "skip", roostId: string) => void;
}

export function buildTrainingBar(
  doc: Document,
  guess: string,
  handlers: { onConfirm: () => void; onReject: () => void; onRecategorize: () => void; onSkip: () => void },
): HTMLElement {
  const bar = doc.createElement("div");
  bar.className = "roost-training-bar";
  const banner = doc.createElement("div");
  banner.className = "roost-training-guess";
  banner.textContent = `Roost guessed: ${guess}`;
  bar.appendChild(banner);
  // Tinder-style circular action row. The two primary decisions (No / Yes) are the
  // large center circles; Recategorize / Skip are the smaller secondary circles.
  // Order left→right: recategorize, reject, confirm, skip.
  const row = doc.createElement("div");
  row.className = "roost-training-row";
  bar.appendChild(row);
  const mk = (action: string, glyph: string, title: string, fn: () => void) => {
    const b = doc.createElement("button");
    b.className = `roost-training-btn roost-training-${action}`;
    b.dataset.action = action;
    b.textContent = glyph;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", fn);
    row.appendChild(b);
  };
  mk("recategorize", "✎", "Recategorize", handlers.onRecategorize);
  mk("reject", "✕", "No — reject (N)", handlers.onReject);
  mk("confirm", "✓", "Yes — keep (Y)", handlers.onConfirm);
  mk("skip", "»", "Skip (S)", handlers.onSkip);
  return bar;
}

function feedResolvers(ctx: FeedRenderContext): EntryMediaResolvers {
  return {
    imagePropId: ctx.imagePropId,
    resolveImageUrl: (entry, propId) => resolveImageUrl(ctx.app, entry, propId),
    resolveVideoUrl: (entry) => resolveVideoUrl(ctx.app, entry),
    resolveAllImages: (entry) => resolveAllImages(ctx.app, entry),
  };
}

function mountFeedActionsRow(
  parent: HTMLElement,
  entry: BasesEntry,
  ctx: FeedRenderContext,
): HTMLElement {
  const roostId = getRoostId(entry);
  const actions = parent.createDiv({ cls: "roost-feed-actions-row" });
  const addAction = (label: string, action: "move" | "open" | "delete") => {
    const btn = actions.createDiv({
      cls: `roost-feed-action roost-feed-action-${action}`,
      text: label,
    });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      ctx.onAction(action, roostId);
    });
  };
  addAction("Move to…", "move");
  addAction("Open note →", "open");
  addAction("Delete", "delete");
  return actions;
}

function maybeAppendTrainingBar(
  el: HTMLElement,
  entry: BasesEntry,
  ctx: FeedRenderContext,
  roostId: string,
): void {
  if (!ctx.trainingMode || !ctx.onTrainingAction) return;
  const { category } = readGuess(entry);
  if (!category) return;
  const bar = buildTrainingBar(el.ownerDocument, category, {
    onConfirm: () => ctx.onTrainingAction!("confirm", roostId),
    onReject: () => ctx.onTrainingAction!("reject", roostId),
    onRecategorize: () => ctx.onTrainingAction!("recategorize", roostId),
    onSkip: () => ctx.onTrainingAction!("skip", roostId),
  });
  el.appendChild(bar);
}

function renderFeedExpandedItem(
  container: HTMLElement,
  entry: BasesEntry,
  ctx: FeedRenderContext,
  opts: { itemClass: string; cardClass: string; frameClass?: string },
): FeedItemHandle {
  container.empty();
  container.addClass(opts.itemClass);

  const mountParent = opts.frameClass
    ? container.createDiv({ cls: opts.frameClass })
    : container;
  const inner = mountParent.createDiv({ cls: opts.cardClass });
  // In training mode only the circular confirm/reject bar shows — hide the actions row.
  const actions = ctx.trainingMode ? null : mountFeedActionsRow(inner, entry, ctx);
  renderExpandedCard(
    inner,
    entryToExpandedCardData(entry, feedResolvers(ctx), actions ? [actions] : []),
  );
  // After the expanded card body, append a full-width link card when the entry has a
  // scraped link preview. Link preview card — click opens the URL in a RoostLinkView tab.
  const feedLinkUrl = safeGetValue(entry, "note.link_url")?.toString();
  if (feedLinkUrl) {
    const feedLinkCard = renderLinkCard(inner, {
      url: feedLinkUrl,
      title: safeGetValue(entry, "note.link_title")?.toString(),
      description: safeGetValue(entry, "note.link_desc")?.toString(),
      site: safeGetValue(entry, "note.link_site")?.toString(),
      imageSrc: resolveImageUrl(ctx.app, entry, "note.link_image"),
    }, { compact: false });
    if (feedLinkCard) {
      feedLinkCard.addEventListener("click", (e) => {
        e.stopPropagation();
        void openLinkInView(ctx.app, feedLinkUrl);
      });
    }
  }
  // Mount on the slot `container` (not `inner`) so the bar overlays at the SAME
  // absolute position for every item type (tweet/image/video), independent of content.
  maybeAppendTrainingBar(container, entry, ctx, getRoostId(entry));

  return {
    dispose: () => {
      container.empty();
      container.removeClass(opts.itemClass);
    },
  };
}

export function inferFeedPlatform(entry: BasesEntry): FeedPlatform {
  const p = safeGetValue(entry, "note.platform")?.toString();
  if (p === "tiktok") return "tiktok";
  if (p === "twitter") return "x";
  return "default";
}

export function renderFeedItem(
  container: HTMLElement,
  entry: BasesEntry,
  ctx: FeedRenderContext,
): FeedItemHandle {
  const platform = inferFeedPlatform(entry);
  if (platform === "tiktok") return renderFeedTikTok(container, entry, ctx);
  if (platform === "x") {
    return renderFeedExpandedItem(container, entry, ctx, {
      itemClass: "roost-feed-item-x",
      frameClass: "roost-feed-x-frame",
      cardClass: "roost-feed-x-card",
    });
  }
  return renderFeedExpandedItem(container, entry, ctx, {
    itemClass: "roost-feed-item-default",
    cardClass: "roost-feed-item-default-card",
  });
}

function renderFeedTikTok(
  container: HTMLElement,
  entry: BasesEntry,
  ctx: FeedRenderContext,
): FeedItemHandle {
  container.empty();
  container.addClass("roost-feed-item-tiktok");

  const videoUrl = resolveVideoUrl(ctx.app, entry);
  const coverUrl = resolveImageUrl(ctx.app, entry, ctx.imagePropId);

  const stage = container.createDiv({ cls: "roost-feed-tiktok-stage" });
  let video: HTMLVideoElement | null = null;
  if (videoUrl) {
    video = stage.createEl("video", { cls: "roost-feed-tiktok-video" });
    video.src = videoUrl;
    video.loop = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.muted = feedMuted;
    if (coverUrl) video.poster = coverUrl;
  } else if (coverUrl) {
    const img = stage.createEl("img", { cls: "roost-feed-tiktok-cover" });
    img.src = coverUrl;
  }

  const muteBtn = container.createDiv({ cls: "roost-feed-tiktok-mute" });
  const renderMute = (m: boolean) => { muteBtn.setText(m ? "🔇" : "🔊"); };
  renderMute(feedMuted);
  muteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setFeedMuted(!feedMuted);
  });
  const muteUnsub = (() => {
    const listener = (m: boolean) => { if (video) video.muted = m; renderMute(m); };
    muteListeners.add(listener);
    return () => muteListeners.delete(listener);
  })();

  const roostId = getRoostId(entry);
  // In training mode only the circular confirm/reject bar shows — hide the action rail.
  if (!ctx.trainingMode) {
    const rail = container.createDiv({ cls: "roost-feed-tiktok-rail" });
    const addRail = (label: string, action: "move" | "open" | "delete") => {
      const btn = rail.createDiv({ cls: `roost-feed-rail-btn roost-feed-rail-${action}`, text: label });
      btn.addEventListener("click", (e) => { e.stopPropagation(); ctx.onAction(action, roostId); });
    };
    addRail("Move", "move");
    addRail("Note", "open");
    addRail("Delete", "delete");
  }

  const caption = container.createDiv({ cls: "roost-feed-tiktok-caption" });
  const author = getNoteAuthor(entry);
  const title = getNoteTitle(entry);
  const tags = parseEntryTags(entry);
  if (author) caption.createDiv({ cls: "roost-feed-tiktok-author", text: `@${author}` });
  caption.createDiv({ cls: "roost-feed-tiktok-title", text: title });
  if (tags?.length) {
    caption.createDiv({
      cls: "roost-feed-tiktok-tags",
      text: tags.map((t) => `#${t}`).join(" "),
    });
  }
  maybeAppendTrainingBar(container, entry, ctx, roostId);

  return {
    activate: () => { if (video) void video.play().catch(() => {}); },
    deactivate: () => { if (video) { video.pause(); video.currentTime = 0; } },
    dispose: () => {
      muteUnsub();
      if (video) { video.pause(); video.src = ""; video.removeAttribute("src"); video.load(); }
      container.empty();
      container.removeClass("roost-feed-item-tiktok");
    },
  };
}
