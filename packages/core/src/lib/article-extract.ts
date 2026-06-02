/**
 * X Article body parser. Converts Twitter's Draft.js content_state — served
 * with an array-shaped entityMap — into markdown for Roost notes.
 *
 * See docs/superpowers/specs/2026-04-30-x-article-body-fetching-design.md
 * for the response shape this parses against.
 */

// ── Types matching Twitter's response shape ──────────────────────────────────

export interface RawDraftStyleRange {
  offset: number;
  length: number;
  style: string;
}

export interface RawDraftEntityRange {
  offset: number;
  length: number;
  key: number;
}

export interface RawDraftBlock {
  key: string;
  type: string;
  text: string;
  depth: number;
  inlineStyleRanges: RawDraftStyleRange[];
  entityRanges: RawDraftEntityRange[];
}

export interface RawDraftEntityValue {
  type: string;
  mutability?: string;
  data?: Record<string, unknown>;
}

interface RawDraftEntityArrayItem {
  key: number | string;
  value: RawDraftEntityValue;
}

export interface RawDraftContentState {
  blocks: RawDraftBlock[];
  // Pre-normalization wire type. Downstream consumers should call
  // normalizeEntityMap() and treat as Record<string, RawDraftEntityValue>.
  entityMap: RawDraftEntityArrayItem[] | Record<string, RawDraftEntityValue>;
}

export interface ArticleResultRaw {
  id?: string;
  rest_id?: string;
  title?: string;
  preview_text?: string;
  cover_media?: {
    media_info?: {
      original_img_url?: string;
      original_img_width?: number;
      original_img_height?: number;
    };
  };
  metadata?: {
    first_published_at_secs?: number;
  };
  lifecycle_state?: {
    modified_at_secs?: number;
  };
  content_state?: RawDraftContentState;
}

// ── Public output type ───────────────────────────────────────────────────────

export interface ArticleContent {
  title: string;
  body: string;
  coverImageUrl: string | null;
  wordCount: number;
  publishedAtSecs: number | null;
}

// ── EntityMap normalization ──────────────────────────────────────────────────

/**
 * Twitter serves entityMap as `[{key, value}, ...]` instead of the standard
 * Draft.js `{key: value, ...}` object map. Convert before processing.
 */
export function normalizeEntityMap(
  em: unknown,
): Record<string, RawDraftEntityValue> {
  if (Array.isArray(em)) {
    const out: Record<string, RawDraftEntityValue> = {};
    for (const entry of em) {
      if (!entry || typeof entry !== "object") continue;
      const k = (entry as RawDraftEntityArrayItem).key;
      if (k === undefined || k === null) continue;
      const v = (entry as RawDraftEntityArrayItem).value;
      if (v === undefined || v === null) continue;
      out[String(k)] = v;
    }
    return out;
  }
  if (em && typeof em === "object") {
    return em as Record<string, RawDraftEntityValue>;
  }
  return {};
}

// ── Top-level entry point ────────────────────────────────────────────────────

/**
 * Convert an article_results.result payload to a Roost ArticleContent.
 * Returns null when content_state is missing or malformed — callers treat
 * null as "render the stub instead."
 */
export function extractArticleContent(
  raw: ArticleResultRaw | null | undefined,
): ArticleContent | null {
  if (!raw || !raw.content_state) return null;
  const blocks = raw.content_state.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) return null;

  const entityMap = normalizeEntityMap(raw.content_state.entityMap);
  const body = renderBlocks(blocks, entityMap);

  return {
    title: typeof raw.title === "string" ? raw.title : "",
    body,
    coverImageUrl: raw.cover_media?.media_info?.original_img_url ?? null,
    wordCount: articleWordCount(raw),
    publishedAtSecs:
      typeof raw.metadata?.first_published_at_secs === "number"
        ? raw.metadata.first_published_at_secs
        : null,
  };
}

/**
 * Compute the word count for an article from its raw block text strings.
 * This is the canonical word-count implementation — operates on the same
 * source data that gets persisted to the `word_count` frontmatter field so
 * all surfaces (in-memory ArticleContent, frontmatter, cache entry) agree.
 */
export function articleWordCount(ar: ArticleResultRaw): number {
  const blocks = ar.content_state?.blocks ?? [];
  let n = 0;
  for (const b of blocks) {
    if (typeof b.text !== "string") continue;
    n += b.text.replace(/[^\w\s]/g, " ").trim().split(/\s+/).filter(Boolean).length;
  }
  return n;
}

// ── Block rendering ──────────────────────────────────────────────────────────

function renderBlocks(blocks: RawDraftBlock[], entityMap: Record<string, RawDraftEntityValue>): string {
  const out: string[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.type === "code-block") {
      // Coalesce consecutive code-blocks into one fence.
      const codeLines: string[] = [];
      while (i < blocks.length && blocks[i].type === "code-block") {
        codeLines.push(blocks[i].text);
        i++;
      }
      out.push("```\n" + codeLines.join("\n") + "\n```");
      continue;
    }
    if (b.type === "unordered-list-item" || b.type === "ordered-list-item") {
      // Coalesce consecutive list items into a tight list (single \n
      // between items). \n\n would produce loose lists, which CommonMark
      // renders with <p> wrappers — wrong for article-prose lists.
      const listLines: string[] = [];
      while (
        i < blocks.length &&
        (blocks[i].type === "unordered-list-item" || blocks[i].type === "ordered-list-item")
      ) {
        listLines.push(renderSingleBlock(blocks[i], entityMap));
        i++;
      }
      out.push(listLines.join("\n"));
      continue;
    }
    out.push(renderSingleBlock(b, entityMap));
    i++;
  }
  return out.join("\n\n");
}

function renderSingleBlock(b: RawDraftBlock, entityMap: Record<string, RawDraftEntityValue>): string {
  const text = renderBlockText(b, entityMap);
  switch (b.type) {
    case "header-one":           return "# " + text;
    case "header-two":           return "## " + text;
    case "header-three":         return "### " + text;
    case "header-four":          return "#### " + text;
    case "header-five":          return "##### " + text;
    case "header-six":           return "###### " + text;
    case "unordered-list-item":  return "  ".repeat(Math.max(0, b.depth ?? 0)) + "- " + text;
    case "ordered-list-item":    return "  ".repeat(Math.max(0, b.depth ?? 0)) + "1. " + text;
    case "blockquote":           return text.split("\n").map(l => "> " + l).join("\n");
    case "atomic":               return renderAtomicBlock(b, entityMap);
    case "unstyled":
    default:                     return text;
  }
}

// ── Inline style rendering ───────────────────────────────────────────────────

const STYLE_WRAPPERS: Record<string, [string, string]> = {
  BOLD:          ["**", "**"],
  ITALIC:        ["*", "*"],
  CODE:          ["`", "`"],
  STRIKETHROUGH: ["~~", "~~"],
};

// Outer-to-inner nesting order: when two ranges cover the same character, the
// later one in this array becomes the inner wrapper. CODE first because
// CommonMark processes inline-code spans before emphasis, so code wraps
// outside other styles when ranges overlap.
const STYLE_PRECEDENCE = ["CODE", "BOLD", "ITALIC", "STRIKETHROUGH"];

function renderBlockText(
  b: RawDraftBlock,
  entityMap: Record<string, RawDraftEntityValue>,
): string {
  return renderInlineWithEntities(b, entityMap);
}

// ── Unified event-driven inline + entity rendering ───────────────────────────

/**
 * Process both inline style ranges and entity ranges in a single event-driven
 * pass. This avoids the two-phase (applyInlineStyles → applyEntityRanges)
 * approach that was fragile when a style boundary coincided with an entity
 * boundary: the second phase had to re-walk the already-serialized styled
 * string with greedy heuristics that could steal the wrong wrapper token.
 *
 * Sort order at the same offset:
 *   1. closes before opens (close inner before opening outer)
 *   2. within opens: entities before styles (entity wrapper goes outside style)
 *   3. within opens of the same category: styles by STYLE_PRECEDENCE (lower
 *      index = outer)
 *   4. within closes: styles before entities (close inner style first)
 *   5. within closes of the same category: reverse of open precedence
 */
function renderInlineWithEntities(
  b: RawDraftBlock,
  entityMap: Record<string, RawDraftEntityValue>,
): string {
  const styleRanges = (b.inlineStyleRanges || []).filter(r => STYLE_WRAPPERS[r.style]);

  type ResolvedEntity = { offset: number; length: number; entity: RawDraftEntityValue };
  const entityRangesResolved: ResolvedEntity[] = [];
  for (const r of (b.entityRanges || [])) {
    const ent = entityMap[String(r.key)];
    if (!ent) continue;
    if (entityEmitsWrappers(ent)) {
      entityRangesResolved.push({ offset: r.offset, length: r.length, entity: ent });
    }
  }

  if (styleRanges.length === 0 && entityRangesResolved.length === 0) {
    return b.text;
  }

  type Event =
    | { kind: "open"; category: "style"; style: string; offset: number }
    | { kind: "close"; category: "style"; style: string; offset: number }
    | { kind: "open"; category: "entity"; entity: RawDraftEntityValue; offset: number }
    | { kind: "close"; category: "entity"; entity: RawDraftEntityValue; offset: number };

  const events: Event[] = [];
  for (const r of styleRanges) {
    events.push({ kind: "open", category: "style", style: r.style, offset: r.offset });
    events.push({ kind: "close", category: "style", style: r.style, offset: r.offset + r.length });
  }
  for (const er of entityRangesResolved) {
    events.push({ kind: "open", category: "entity", entity: er.entity, offset: er.offset });
    events.push({ kind: "close", category: "entity", entity: er.entity, offset: er.offset + er.length });
  }

  events.sort((a, b) => {
    if (a.offset !== b.offset) return a.offset - b.offset;
    // Closes before opens.
    if (a.kind !== b.kind) return a.kind === "close" ? -1 : 1;
    if (a.kind === "open") {
      // Entities open before styles (entity becomes outer wrapper).
      if (a.category !== b.category) return a.category === "entity" ? -1 : 1;
      // Both styles: lower-precedence index opens first (becomes outer).
      if (a.category === "style" && b.category === "style") {
        return STYLE_PRECEDENCE.indexOf(a.style) - STYLE_PRECEDENCE.indexOf(b.style);
      }
      return 0;
    }
    // Both closes: styles close first (inner), entities close last (outer).
    if (a.category !== b.category) return a.category === "style" ? -1 : 1;
    if (a.category === "style" && b.category === "style") {
      return STYLE_PRECEDENCE.indexOf(b.style) - STYLE_PRECEDENCE.indexOf(a.style);
    }
    return 0;
  });

  const out: string[] = [];
  let cursor = 0;
  let evIdx = 0;
  for (let i = 0; i <= b.text.length; i++) {
    while (evIdx < events.length && events[evIdx].offset === i) {
      const ev = events[evIdx++];
      if (i > cursor) {
        out.push(b.text.slice(cursor, i));
        cursor = i;
      }
      if (ev.category === "style") {
        const wrapper = STYLE_WRAPPERS[ev.style];
        out.push(ev.kind === "open" ? wrapper[0] : wrapper[1]);
      } else {
        // entity
        if (ev.kind === "open") {
          out.push("[");
        } else {
          out.push("](" + (extractEntityUrl(ev.entity) ?? "") + ")");
        }
      }
    }
  }
  if (cursor < b.text.length) out.push(b.text.slice(cursor));
  return out.join("");
}

/** Whether a non-atomic entity contributes wrappers around its inner text. */
function entityEmitsWrappers(ent: RawDraftEntityValue): boolean {
  if (ent.type === "LINK") {
    return typeof ent.data?.url === "string" && (ent.data.url as string).length > 0;
  }
  if (ent.type === "MEDIA") {
    return typeof ent.data?.url === "string" && (ent.data.url as string).length > 0;
  }
  // TWEMOJI, MARKDOWN, unknown — pass through without wrappers.
  return false;
}

function extractEntityUrl(ent: RawDraftEntityValue): string | null {
  const url = ent.data?.url;
  return typeof url === "string" ? url : null;
}

// ── Atomic block rendering ───────────────────────────────────────────────────

function renderAtomicBlock(
  b: RawDraftBlock,
  entityMap: Record<string, RawDraftEntityValue>,
): string {
  const range = (b.entityRanges || [])[0];
  if (!range) return b.text;
  const entity = entityMap[String(range.key)];
  if (!entity) return b.text;
  if (entity.type === "MEDIA") {
    const url = (entity.data?.url as string) || "";
    const alt = (entity.data?.alt as string) || "";
    return url ? "![" + alt + "](" + url + ")" : "";
  }
  // Other atomic types (e.g., embedded tweets, dividers) — render the entity
  // body as plain text. Future work: tweet ID → link, divider → "---".
  return b.text;
}

// ── Note rendering helpers (used by extract.ts) ─────────────────────────────

export function renderArticleNoteBody(article: ArticleContent): string {
  const parts: string[] = [];
  parts.push("# " + (article.title || "(untitled)"));
  if (article.coverImageUrl) {
    parts.push("![cover](" + article.coverImageUrl + ")");
  }
  if (article.body) {
    parts.push(article.body);
  }
  return parts.join("\n\n");
}

export function renderArticleStubBody(raw: ArticleResultRaw): string {
  const parts: string[] = [];
  parts.push("# " + (raw.title || "(untitled)"));
  const cover = raw.cover_media?.media_info?.original_img_url;
  if (cover) {
    parts.push("![cover](" + cover + ")");
  }
  if (raw.preview_text) {
    parts.push("> " + raw.preview_text);
  }
  parts.push("*Article body not yet fetched.*");
  return parts.join("\n\n");
}
