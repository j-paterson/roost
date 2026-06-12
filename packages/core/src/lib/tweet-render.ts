/**
 * Pure renderer that turns an X/Twitter bookmark record into a formatted
 * markdown note body — line breaks, linkified @mentions / #hashtags / URLs,
 * reply + quoted-tweet context as blockquotes, and explicit thread structure.
 *
 * This is the text-fidelity counterpart to `card-renderer.ts` (which produces
 * the gallery PNG). The PNG only *colors* entities for pixels; this renderer
 * emits real, searchable, selectable markdown links into the note body.
 *
 * No vault/disk I/O lives here so it unit-tests with a plain object.
 *
 * IMPORTANT (article handling, Decision 4): X Articles already render real
 * markdown via `extractBookmarkText`. A *direct* article is returned byte-for-
 * byte unchanged. But `extractBookmarkText` also routes a plain tweet that
 * *quotes* an Article to the quoted article's markdown — so for a
 * quote-of-article we must NOT treat it as an article; we render the host
 * tweet's own text and the quoted article as a blockquote (Step 1/2).
 */
import { roostUnwrapTweet, type RawApiData } from "./normalize";
import { extractBookmarkText, extractTwitterMedia, type BookmarkRecord } from "./extract";

/** A run of plain text or a tokenized entity (mention/hashtag/URL). */
interface TextRun {
  text: string;
  isEntity?: boolean;
}

/** Options for renderTweetBody. `mediaEmbeds` are fully-formed embed lines
 *  (e.g. "![[Bookmarks/X/twitter-111/1.jpg]]") appended below the rendered
 *  text. The caller owns path construction; this renderer stays pure. */
export interface RenderTweetBodyOptions {
  mediaEmbeds?: string[];
}

// Copied verbatim from card-renderer.ts:125 — do NOT import (keeps this file
// free of the OffscreenCanvas-bearing module). The colored-run loop below
// mirrors card-renderer.ts:128-141 but emits markdown links instead of colors.
const ENTITY_RE = /(@[A-Za-z0-9_]{1,15})|(#[\w]+)|(https?:\/\/\S+|[A-Za-z0-9-]+\.[A-Za-z]{2,}\/\S*|\S+\.(?:com|net|org|io|ai|co|app|dev|me|gg|xyz|so)\b\S*)/g;

/** Split a single line into runs of plain text vs. matched entities. */
function tokenizeRuns(line: string): TextRun[] {
  const runs: TextRun[] = [];
  let lastIndex = 0;
  ENTITY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENTITY_RE.exec(line))) {
    if (m.index > lastIndex) runs.push({ text: line.slice(lastIndex, m.index) });
    runs.push({ text: m[0], isEntity: true });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < line.length) runs.push({ text: line.slice(lastIndex) });
  return runs.length > 0 ? runs : [{ text: line }];
}

/**
 * Backslash-escape the markdown-significant characters that appear inside free
 * tweet text, so the renderer's own structure (paragraphs, blockquotes, links)
 * stays intact and stray tweet characters don't render as formatting.
 *
 * Minimal-but-sufficient set (widen if users report glitches):
 *   inline:  \ * _ ` [ ] < >
 *   leading: # - > and "<digit>." at the very start of a line (so a tweet line
 *            like "> hi" or "1. x" doesn't become a blockquote / ordered list).
 * Applied ONLY to non-entity spans — the link syntax we emit is never escaped.
 */
function escapeMarkdownInline(text: string): string {
  return text.replace(/[\\*_`\[\]<>]/g, "\\$&");
}

function escapeMarkdownLine(line: string): string {
  let out = escapeMarkdownInline(line);
  // Leading block-level markers: escape only the first significant char.
  out = out.replace(/^(\s*)([#\->])/, "$1\\$2");
  out = out.replace(/^(\s*)(\d+)\./, "$1$2\\.");
  return out;
}

/** True when the URL match has more "(" than ")" — i.e. a trailing ")" is part
 *  of the URL (e.g. a Wikipedia "Foo_(bar)" link) and must not be trimmed. */
function hasUnbalancedOpenParen(url: string): boolean {
  let depth = 0;
  for (const ch of url) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
  }
  return depth > 0;
}

/** Render one matched URL entity as a markdown link, trimming trailing
 *  sentence punctuation and prefixing a scheme in the href when absent. */
function renderUrlEntity(match: string): string {
  // ENTITY_RE's bare-domain branch also matches emails ("a@b.com"); render
  // those as plain escaped text rather than emitting a bogus link.
  if (/^[^/@\s]+@[^/@\s]+\.[^/@\s]+$/.test(match)) return escapeMarkdownInline(match);
  let display = match;
  // Trim trailing punctuation, but keep a ")" when the URL has an unbalanced
  // "(" earlier (so "...Foo_(bar)" keeps its closing paren).
  let trimmed = "";
  while (display.length > 0) {
    const last = display[display.length - 1];
    if (".,!?;:".includes(last)) {
      trimmed = last + trimmed;
      display = display.slice(0, -1);
    } else if (last === ")" && !hasUnbalancedOpenParen(display.slice(0, -1))) {
      trimmed = last + trimmed;
      display = display.slice(0, -1);
    } else {
      break;
    }
  }
  const href = /^https?:\/\//i.test(display) ? display : `https://${display}`;
  // Percent-encode the chars that would otherwise terminate the markdown link
  // destination early — a mid-path/unbalanced "(" / ")", a "[" / "]", or a
  // space. The visible display keeps the literal characters (readable URL);
  // "[" / "]" in the display are backslash-escaped so they don't break the
  // "[display]" portion. Balanced parens still render fine either way.
  // NB: encodeURIComponent leaves "(" / ")" unescaped (they're in its
  // unreserved set), so percent-encode by code point to actually catch parens.
  const safeHref = href.replace(/[()[\] ]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  const safeDisplay = display.replace(/[[\]]/g, "\\$&");
  return `[${safeDisplay}](${safeHref})${trimmed}`;
}

/** Linkify + escape a single line: escape non-entity spans, emit markdown for
 *  @mentions, #hashtags, and URLs. Escape FIRST, then linkify, so the link
 *  syntax we generate is never itself escaped. The leading block-level escape
 *  (#, -, >, "<digit>.") applies only to the very first run of the line. */
function renderLine(line: string): string {
  const runs = tokenizeRuns(line);
  let out = "";
  let isLineStart = true;
  for (const run of runs) {
    if (!run.isEntity) {
      out += isLineStart ? escapeMarkdownLine(run.text) : escapeMarkdownInline(run.text);
      isLineStart = false;
      continue;
    }
    isLineStart = false;
    const t = run.text;
    if (t.startsWith("@")) {
      const user = t.slice(1);
      out += `[@${user}](https://x.com/${user})`;
    } else if (t.startsWith("#")) {
      const tag = t.slice(1);
      out += `[#${tag}](https://x.com/hashtag/${tag})`;
    } else {
      out += renderUrlEntity(t);
    }
  }
  return out;
}

/** Render a multi-paragraph block of tweet free-text into formatted markdown.
 *  Soft breaks (single \n within a paragraph) become markdown hard breaks via
 *  two trailing spaces; paragraphs (blank-line separated) join with "\n\n". */
function renderText(text: string): string {
  if (!text) return "";
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n");
  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const renderedParas = paragraphs.map((para) => {
    const lines = para.split("\n");
    const renderedLines = lines.map((line) => renderLine(line));
    // Two trailing spaces before each soft break (markdown hard break),
    // applied to every line except the paragraph's last.
    return renderedLines
      .map((rl, i) => (i < renderedLines.length - 1 ? rl + "  " : rl))
      .join("\n");
  });

  return renderedParas.join("\n\n");
}

/** Append media embed lines below the rendered tweet text. A blank line
 *  separates them; the embeds join with "\n". Pure — no path logic. */
function appendMediaEmbeds(body: string, embeds: string[] | undefined): string {
  const lines = (embeds ?? []).filter((e) => e && e.trim().length > 0);
  if (lines.length === 0) return body;
  const joined = lines.join("\n");
  return body ? `${body}\n\n${joined}` : joined;
}

/** Resolve the *direct* article result (top-level only — NOT the quoted path),
 *  matching the Decision-4 "articles are untouched" split. */
function getDirectArticleResult(rawData: RawApiData | undefined): unknown {
  if (!rawData) return null;
  const unwrapped = roostUnwrapTweet(rawData);
  const fromUnwrapped =
    (unwrapped as RawApiData | null)?.article?.article_results?.result ?? null;
  const fromRaw =
    (rawData as RawApiData)?.article?.article_results?.result ?? null;
  return fromUnwrapped ?? fromRaw ?? null;
}

/** True when the record is a direct X Article (renderer leaves it untouched). */
export function isDirectArticle(record: BookmarkRecord): boolean {
  return !!getDirectArticleResult(record?.rawData);
}

/**
 * The host tweet's OWN expanded plain text.
 *
 * `extractBookmarkText` routes a tweet that *quotes an Article* to the quoted
 * article's markdown (the "quoted-article trap", see extract.ts:152-161) and
 * drops the host's own text. To get the host's text we strip the quoted-status
 * objects before calling it — with no quoted article in scope, the article
 * branch can't fire and `extractBookmarkText` returns the host's expanded text.
 * (We don't import the module-private `expandTweetUrls`.)
 */
function getHostTweetText(record: BookmarkRecord): string {
  const rawData = record.rawData as RawApiData | undefined;
  if (!rawData) return "";
  const unwrapped = roostUnwrapTweet(rawData);
  const hasQuotedArticle =
    !!(unwrapped as RawApiData | null)?.quoted_status_result?.result?.article?.article_results?.result ||
    !!(rawData as RawApiData)?.quoted_status_result?.result?.article?.article_results?.result;
  if (!hasQuotedArticle) return extractBookmarkText(record);
  // Shallow-clone with the quoted-status objects removed so the article branch
  // of extractBookmarkText can't pick up the quoted article.
  const stripped: RawApiData = { ...rawData };
  delete stripped.quoted_status_result;
  delete stripped.quotedRefResult;
  // The host text may itself live under a wrapper (tweet/result) — clone there
  // too so the stripped quoted-status is the one extractBookmarkText reads.
  if (unwrapped && unwrapped !== rawData) {
    // Strip on the unwrapped layer as well; rebuild via the same record so
    // getBookmarkRawData still resolves the host's full_text.
    const strippedUnwrapped: RawApiData = { ...unwrapped };
    delete strippedUnwrapped.quoted_status_result;
    delete strippedUnwrapped.quotedRefResult;
    return extractBookmarkText({ platform: "twitter", itemId: record.itemId, rawData: strippedUnwrapped });
  }
  return extractBookmarkText({ platform: "twitter", itemId: record.itemId, rawData: stripped });
}

/** Render the plain-tweet branch: text + line breaks + linkified entities,
 *  with reply context prepended and quoted-tweet context appended as
 *  blockquotes. */
function renderPlainTweet(record: BookmarkRecord): string {
  const text = getHostTweetText(record);
  const media = extractTwitterMedia(record);

  const parts: string[] = [];

  // Reply context — prepended.
  if (media.replyTo) {
    parts.push(`> Replying to [@${media.replyTo}](https://x.com/${media.replyTo})`);
  }

  const body = renderText(text);
  if (body) parts.push(body);

  // Quoted tweet (incl. quote-of-article) — appended as a blockquote.
  if (media.quotedTweet) {
    const qAuthor = media.quotedTweet.author;
    const quoteLines: string[] = [];
    quoteLines.push(`[@${qAuthor}](https://x.com/${qAuthor})`);
    const renderedQuote = renderText(media.quotedTweet.text);
    if (renderedQuote) {
      for (const line of renderedQuote.split("\n")) quoteLines.push(line);
    }
    parts.push(quoteLines.map((l) => `> ${l}`).join("\n"));
  }

  return parts.join("\n\n");
}

interface ThreadSegmentLike {
  rest_id: string;
  raw: RawApiData;
}

/** Render a thread: read `_thread` / `_quoted_thread` straight off rawData
 *  (roostUnwrapTweet strips them), render each segment with the plain-tweet
 *  helper, and join with the same separators the PNG carousel uses. */
function renderThread(record: BookmarkRecord): string {
  const rawData = record.rawData as RawApiData;
  const mainThread = (rawData._thread as ThreadSegmentLike[] | undefined) || [];
  const quotedThread = (rawData._quoted_thread as ThreadSegmentLike[] | undefined) || [];

  const renderSegments = (segments: ThreadSegmentLike[]): string => {
    return segments
      .map((seg) =>
        renderPlainTweet({ platform: "twitter", itemId: seg.rest_id, rawData: seg.raw }),
      )
      .filter(Boolean)
      .join("\n\n---\n\n");
  };

  const parts: string[] = [];
  const mainBody = renderSegments(mainThread);
  if (mainBody) parts.push(mainBody);
  if (quotedThread.length > 0) {
    const quotedBody = renderSegments(quotedThread);
    if (quotedBody) parts.push("**Quoted thread:**", quotedBody);
  }
  return parts.join("\n\n");
}

/**
 * Render an X/Twitter bookmark record as a formatted markdown note body.
 *
 * Dispatch:
 *   1. Direct article  → `extractBookmarkText(record)` unchanged (Decision 4).
 *   2. Thread          → segment-by-segment plain render joined with "---".
 *   3. Plain tweet     → text + entities + reply/quote blockquotes.
 *      (A quote-of-article falls here: host text rendered, quoted article quoted.)
 */
export function renderTweetBody(record: BookmarkRecord, opts?: RenderTweetBodyOptions): string {
  if (isDirectArticle(record)) return extractBookmarkText(record);

  const rawData = record.rawData as RawApiData | undefined;
  const mainThread = (rawData?._thread as unknown[] | undefined) || [];
  const quotedThread = (rawData?._quoted_thread as unknown[] | undefined) || [];
  const text = (mainThread.length > 0 || quotedThread.length > 0)
    ? renderThread(record)
    : renderPlainTweet(record);

  return appendMediaEmbeds(text, opts?.mediaEmbeds);
}
