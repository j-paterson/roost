/**
 * Native tweet DOM — renders a TweetThreadView as a Twitter-like reading layout
 * (avatar + @handle + date header, real entity links, reply-to context, quoted
 * tweets as nested cards, threads as a connected vertical list).
 *
 * Vanilla DOM (Obsidian createDiv/createEl) so it works in the gallery's
 * BasesView expand. Verified visually; the data shaping lives in the
 * unit-tested tweet-view-model.ts.
 */
import type { TweetSegmentView, TweetThreadView } from "@/views/tweet-view-model";

// X glyph (simple-icons path), drawn in currentColor. Trusted in-repo constant.
const X_LOGO_SVG =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>' +
  "</svg>";

// Matches @mentions, #hashtags, and URLs (incl. bare domains). Mirrors the
// tweet-render / card-renderer entity grammar so links render consistently.
const ENTITY_RE =
  /(@[A-Za-z0-9_]{1,15})|(#[\w]+)|(https?:\/\/\S+|[A-Za-z0-9-]+\.[A-Za-z]{2,}\/\S*|\S+\.(?:com|net|org|io|ai|co|app|dev|me|gg|xyz|so)\b\S*)/g;

function openExternal(url: string): void {
  window.open(url, "_blank");
}

function appendEntityLink(parent: HTMLElement, text: string): void {
  let href: string | null = null;
  if (text.startsWith("@")) href = `https://x.com/${text.slice(1)}`;
  else if (text.startsWith("#")) href = `https://x.com/hashtag/${text.slice(1)}`;
  else href = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  const a = parent.createEl("a", { cls: "roost-tweet-link", text, href });
  a.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openExternal(href!);
  });
}

/** Render free tweet text into `container`: paragraphs (blank-line split),
 *  soft line breaks, and @mention / #hashtag / URL entities as real links. */
function renderTweetText(container: HTMLElement, text: string): void {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n");
  const paragraphs = normalized.split(/\n\s*\n/).map((p) => p.replace(/\s+$/, "")).filter(Boolean);
  for (const para of paragraphs) {
    const p = container.createDiv({ cls: "roost-tweet-para" });
    para.split("\n").forEach((line, i) => {
      if (i > 0) p.createEl("br");
      ENTITY_RE.lastIndex = 0;
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = ENTITY_RE.exec(line))) {
        if (m.index > last) p.createSpan({ text: line.slice(last, m.index) });
        appendEntityLink(p, m[0]);
        last = m.index + m[0].length;
      }
      if (last < line.length) p.createSpan({ text: line.slice(last) });
    });
  }
}

function formatTweetDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function renderPhotos(parent: HTMLElement, photoUrls: string[]): void {
  if (photoUrls.length === 0) return;
  const grid = parent.createDiv({
    cls: `roost-tweet-photos roost-photo-grid-${Math.min(photoUrls.length, 4)}`,
  });
  for (const url of photoUrls) {
    const img = grid.createEl("img", { cls: "roost-tweet-photo" });
    img.src = url;
    img.loading = "lazy";
  }
}

function renderQuote(parent: HTMLElement, quoted: { author: string | null; text: string }): void {
  const card = parent.createDiv({ cls: "roost-tweet-quote" });
  if (quoted.author) {
    const head = card.createDiv({ cls: "roost-tweet-quote-head" });
    head.createSpan({ cls: "roost-tweet-quote-avatar", text: quoted.author[0]?.toUpperCase() ?? "?" });
    head.createSpan({ cls: "roost-tweet-quote-handle", text: `@${quoted.author.replace(/^@/, "")}` });
  }
  const body = card.createDiv({ cls: "roost-tweet-quote-text" });
  renderTweetText(body, quoted.text);
}

function renderSegment(parent: HTMLElement, seg: TweetSegmentView, focalUrl: string | null): void {
  const segEl = parent.createDiv({ cls: "roost-tweet-segment" });
  if (seg.isFocal) segEl.addClass("roost-tweet-focal");

  const head = segEl.createDiv({ cls: "roost-tweet-head" });
  const handle = seg.author ? `@${seg.author.replace(/^@/, "")}` : "@unknown";
  head.createSpan({ cls: "roost-tweet-avatar", text: (seg.author?.[0] ?? "?").toUpperCase() });
  const meta = head.createDiv({ cls: "roost-tweet-meta" });
  // The focal segment links its handle to the bookmarked tweet URL; other
  // segments link to the author profile.
  const handleHref = seg.isFocal && focalUrl ? focalUrl : seg.author ? `https://x.com/${seg.author.replace(/^@/, "")}` : null;
  if (handleHref) {
    const a = meta.createEl("a", { cls: "roost-tweet-handle", text: handle, href: handleHref });
    a.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); openExternal(handleHref); });
  } else {
    meta.createSpan({ cls: "roost-tweet-handle", text: handle });
  }
  const date = formatTweetDate(seg.date);
  if (date) meta.createSpan({ cls: "roost-tweet-date", text: `· ${date}` });
  const logo = head.createDiv({ cls: "roost-tweet-logo" });
  logo.innerHTML = X_LOGO_SVG;

  if (seg.replyTo) {
    const reply = segEl.createDiv({ cls: "roost-tweet-reply" });
    reply.createSpan({ text: "Replying to " });
    appendEntityLink(reply, `@${seg.replyTo.replace(/^@/, "")}`);
  }

  if (seg.text.trim()) {
    const textEl = segEl.createDiv({ cls: "roost-tweet-text" });
    renderTweetText(textEl, seg.text);
  }

  renderPhotos(segEl, seg.photoUrls);

  if (seg.quoted) renderQuote(segEl, seg.quoted);
}

/** Render the whole thread view into `container`. */
export function renderTweetThread(
  container: HTMLElement,
  view: TweetThreadView,
  opts: { url?: string | null } = {},
): void {
  const root = container.createDiv({ cls: "roost-tweet" });
  const focalUrl = opts.url ?? null;
  // A multi-segment main thread gets the connector treatment via CSS.
  if (view.segments.length > 1) root.addClass("roost-tweet-threaded");
  for (const seg of view.segments) renderSegment(root, seg, focalUrl);

  if (view.quotedThread.length > 0) {
    root.createDiv({ cls: "roost-tweet-quoted-label", text: "Quoted thread" });
    const quotedRoot = root.createDiv({ cls: "roost-tweet roost-tweet-quoted-thread" });
    if (view.quotedThread.length > 1) quotedRoot.addClass("roost-tweet-threaded");
    for (const seg of view.quotedThread) renderSegment(quotedRoot, seg, null);
  }
}
