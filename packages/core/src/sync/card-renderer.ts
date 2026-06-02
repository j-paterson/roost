/**
 * Tweet/cast card renderer — ported from roost-app/src/eagle/card-renderer.js.
 * Uses browser OffscreenCanvas instead of node-canvas (native module).
 *
 * Pure helpers (paragraph split, char-breaking word wrap, entity tokenizing)
 * are exported so they can be unit-tested without OffscreenCanvas.
 */
import { CARD_WIDTH, CARD_PADDING, CARD_MAX_LINES } from "@/config";

interface SubContext {
  type: "quote" | "reply";
  author: string | null;
  username: string | null;
  text: string | null;
  /** Decoded bitmap for a quoted-tweet image, drawn below the quoted text. */
  image?: ImageBitmap | null;
}

interface RenderCardOpts {
  author: string;
  username: string | null;
  text: string;
  publishedAt: string | null;
  subContext?: SubContext | null;
  /** Mark this card as the bookmarked tweet inside a thread — draws an accent border and a "★ bookmarked" pill. */
  focal?: boolean;
}

const QUOTE_IMAGE_MAX_HEIGHT = 220;
const QUOTE_IMAGE_GAP = 10;
const PARAGRAPH_GAP = 8;
const ENTITY_COLOR = "#1d9bf0";
const BODY_COLOR = "#374151";

/** Result of splitting raw text into paragraphs (separated by one-or-more blank lines).
 *  Internal `\n` (soft line breaks) are preserved so DOM renderers can keep
 *  the original structure (e.g. Twitter `>` quote-bullet stacks). Pixel
 *  renderers should flatten them at the call site. */
export function splitParagraphs(text: string): string[] {
  if (!text) return [];
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n");
  return normalized
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

interface CtxLike {
  measureText(s: string): { width: number };
}

/**
 * Word-wrap a paragraph to fit `maxWidth`, breaking single tokens at character
 * boundaries when they exceed the available width on their own (URLs, long
 * hash strings). Honors a hard `maxLines` cap; appends "…" to the last line
 * if anything is dropped. Returns { lines, truncated }.
 */
export function wrapParagraph(
  ctx: CtxLike,
  text: string,
  maxWidth: number,
  maxLines: number,
): { lines: string[]; truncated: boolean } {
  if (maxLines <= 0) return { lines: [], truncated: text.trim().length > 0 };
  const words = (text || "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  const pushLine = (s: string): boolean => {
    lines.push(s);
    return lines.length >= maxLines;
  };

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width <= maxWidth) {
      current = test;
      continue;
    }

    // `test` overflows. Flush `current` (if any), then handle the word.
    if (current) {
      if (pushLine(current)) {
        const remaining = word;
        lines[lines.length - 1] += "…";
        return { lines, truncated: remaining.length > 0 };
      }
      current = "";
    }

    // Word may itself be wider than maxWidth — char-break it.
    if (ctx.measureText(word).width <= maxWidth) {
      current = word;
      continue;
    }

    let buf = "";
    for (const ch of word) {
      const next = buf + ch;
      if (ctx.measureText(next).width <= maxWidth) {
        buf = next;
      } else {
        if (buf) {
          if (pushLine(buf)) {
            lines[lines.length - 1] += "…";
            return { lines, truncated: true };
          }
        }
        buf = ch;
      }
    }
    current = buf;
  }

  if (current) lines.push(current);
  return { lines, truncated: false };
}

/** A run of text + an optional foreground color (defaults to body color). */
export interface TextRun {
  text: string;
  color?: string;
}

const ENTITY_RE = /(@[A-Za-z0-9_]{1,15})|(#[\w]+)|(https?:\/\/\S+|[A-Za-z0-9-]+\.[A-Za-z]{2,}\/\S*|\S+\.(?:com|net|org|io|ai|co|app|dev|me|gg|xyz|so)\b\S*)/g;

/** Split a single line into colored runs for @mentions, #hashtags, URLs. */
export function tokenizeRuns(line: string): TextRun[] {
  const runs: TextRun[] = [];
  let lastIndex = 0;
  ENTITY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENTITY_RE.exec(line))) {
    if (m.index > lastIndex) {
      runs.push({ text: line.slice(lastIndex, m.index) });
    }
    runs.push({ text: m[0], color: ENTITY_COLOR });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < line.length) runs.push({ text: line.slice(lastIndex) });
  return runs.length > 0 ? runs : [{ text: line }];
}

/** Short date for the top-right of the header: "Mar 5 · 3:42 PM" (en-US). */
function formatHeaderDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d
    .toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
    .replace(", ", " · ");
}

function drawRuns(
  ctx: OffscreenCanvasRenderingContext2D,
  runs: TextRun[],
  x: number,
  y: number,
): void {
  let cursorX = x;
  for (const run of runs) {
    ctx.fillStyle = run.color ?? BODY_COLOR;
    ctx.fillText(run.text, cursorX, y);
    cursorX += ctx.measureText(run.text).width;
  }
}

function drawSubContext(
  ctx: OffscreenCanvasRenderingContext2D,
  subContext: SubContext,
  subLines: string[],
  x: number, y: number, width: number,
  imageDims: { w: number; h: number } | null,
): number {
  const LINE_HEIGHT = 20;
  const BAR_WIDTH = 3;
  const BAR_GAP = 10;
  const HEADER_HEIGHT = 22;
  const imageH = imageDims ? imageDims.h + QUOTE_IMAGE_GAP : 0;
  const blockHeight = HEADER_HEIGHT + subLines.length * LINE_HEIGHT + imageH + 8;

  ctx.fillStyle = "#f3f4f6";
  ctx.fillRect(x, y, width, blockHeight);
  ctx.fillStyle = "#d1d5db";
  ctx.fillRect(x, y, BAR_WIDTH, blockHeight);

  const textX = x + BAR_WIDTH + BAR_GAP;
  ctx.fillStyle = "#6b7280";
  ctx.font = "bold 13px sans-serif";
  ctx.fillText(subContext.username ? `@${subContext.username}` : "@unknown", textX, y + 16);

  let cursorY = y + HEADER_HEIGHT;
  if (subLines.length > 0) {
    ctx.font = "13px sans-serif";
    for (const line of subLines) {
      drawRuns(ctx, tokenizeRuns(line), textX, cursorY + 14);
      cursorY += LINE_HEIGHT;
    }
  }

  if (imageDims && subContext.image) {
    ctx.drawImage(subContext.image, textX, cursorY + QUOTE_IMAGE_GAP, imageDims.w, imageDims.h);
  }
  return blockHeight;
}

/** Wrap an entire body (multi-paragraph) into a list of (paragraph, lines) blocks. */
interface BodyBlock {
  lines: string[];
}
function wrapBody(
  ctx: CtxLike,
  text: string,
  maxWidth: number,
  maxLines: number,
): { blocks: BodyBlock[]; truncated: boolean } {
  // PNG layout treats hard \n inside a paragraph as a space — the canvas
  // wrapper word-wraps freely. DOM renderers handle \n separately.
  const paragraphs = splitParagraphs(text).map((p) => p.replace(/\n/g, " "));
  const blocks: BodyBlock[] = [];
  let remaining = maxLines;
  let truncated = false;
  for (let i = 0; i < paragraphs.length; i++) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const { lines, truncated: tr } = wrapParagraph(ctx, paragraphs[i], maxWidth, remaining);
    blocks.push({ lines });
    remaining -= lines.length;
    if (tr) {
      truncated = true;
      break;
    }
  }
  return { blocks, truncated };
}

/**
 * Render a text-only tweet as a PNG ArrayBuffer.
 */
export async function renderCardAsync(opts: RenderCardOpts): Promise<ArrayBuffer | null> {
  try {
    const { author, username, text, publishedAt, subContext, focal } = opts;

    const WIDTH = CARD_WIDTH;
    const PADDING = CARD_PADDING;
    const MAX_LINES = CARD_MAX_LINES;
    const LINE_HEIGHT = 22;
    const SUB_LINE_HEIGHT = 20;
    const CONTENT_WIDTH = WIDTH - PADDING * 2;
    const SUB_MAX_LINES = 6;

    const tmpCanvas = new OffscreenCanvas(WIDTH, 100);
    const tmpCtx = tmpCanvas.getContext("2d")!;

    tmpCtx.font = "15px sans-serif";
    const { blocks, truncated } = wrapBody(tmpCtx, text, CONTENT_WIDTH, MAX_LINES);

    let subLines: string[] = [];
    let subBlockH = 0;
    let replyIndicatorH = 0;
    let subImageDims: { w: number; h: number } | null = null;

    if (subContext) {
      if (subContext.image) {
        const imgMaxW = CONTENT_WIDTH - 20 - 13;
        const scale = Math.min(imgMaxW / subContext.image.width, QUOTE_IMAGE_MAX_HEIGHT / subContext.image.height, 1);
        subImageDims = {
          w: Math.round(subContext.image.width * scale),
          h: Math.round(subContext.image.height * scale),
        };
      }
      if (subContext.text) {
        tmpCtx.font = "13px sans-serif";
        const wrapped = wrapParagraph(tmpCtx, subContext.text, CONTENT_WIDTH - 20, SUB_MAX_LINES);
        subLines = wrapped.lines;
        const imageH = subImageDims ? subImageDims.h + QUOTE_IMAGE_GAP : 0;
        subBlockH = 22 + subLines.length * SUB_LINE_HEIGHT + imageH + 8 + 12;
      } else if (subImageDims) {
        subBlockH = 22 + subImageDims.h + QUOTE_IMAGE_GAP + 8 + 12;
      } else if (subContext.type === "reply" && subContext.username) {
        replyIndicatorH = 28;
      }
    }

    const headerH = 60;
    const totalBodyLines = blocks.reduce((n, b) => n + b.lines.length, 0);
    const interParagraphGap = Math.max(0, blocks.length - 1) * PARAGRAPH_GAP;
    const textH = totalBodyLines * LINE_HEIGHT + interParagraphGap + (truncated ? 8 : 0);
    const footerH = 36;
    const aboveH = subContext?.type === "reply" ? (subBlockH || replyIndicatorH) : 0;
    const belowH = subContext?.type === "quote" ? subBlockH : 0;
    const HEIGHT = PADDING + aboveH + headerH + textH + belowH + footerH + PADDING;

    const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
    const ctx = canvas.getContext("2d")!;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.strokeStyle = focal ? "#f59e0b" : "#e5e7eb";
    ctx.lineWidth = focal ? 3 : 2;
    ctx.strokeRect(1, 1, WIDTH - 2, HEIGHT - 2);

    let y = PADDING;

    if (subContext?.type === "reply" && aboveH > 0) {
      if (subContext.text && subLines.length > 0) {
        drawSubContext(ctx, subContext, subLines, PADDING, y, CONTENT_WIDTH, subImageDims);
        y += subBlockH;
      } else if (replyIndicatorH > 0) {
        ctx.fillStyle = "#9ca3af";
        ctx.font = "13px sans-serif";
        ctx.fillText(`↩ Replying to @${subContext.username}`, PADDING, y + 16);
        y += replyIndicatorH;
      }
    }

    // ── Header: author (left) + date (right) ──
    ctx.fillStyle = "#111827";
    ctx.font = "bold 16px sans-serif";
    ctx.fillText(author || "Unknown", PADDING, y + 20);
    ctx.fillStyle = "#6b7280";
    ctx.font = "14px sans-serif";
    ctx.fillText(`@${username || "unknown"}`, PADDING, y + 42);

    const headerDate = formatHeaderDate(publishedAt);
    if (headerDate) {
      ctx.fillStyle = "#9ca3af";
      ctx.font = "13px sans-serif";
      const dateW = ctx.measureText(headerDate).width;
      ctx.fillText(headerDate, WIDTH - PADDING - dateW, y + 20);
    }

    if (focal) {
      const pillText = "★ bookmarked";
      ctx.font = "bold 11px sans-serif";
      const textW = ctx.measureText(pillText).width;
      const pillPadX = 10;
      const pillW = textW + pillPadX * 2;
      const pillH = 22;
      const pillX = WIDTH - PADDING - pillW;
      const pillY = y + 36; // below the date, top-right corner
      ctx.fillStyle = "#fef3c7";
      ctx.beginPath();
      const r = pillH / 2;
      ctx.moveTo(pillX + r, pillY);
      ctx.arcTo(pillX + pillW, pillY, pillX + pillW, pillY + pillH, r);
      ctx.arcTo(pillX + pillW, pillY + pillH, pillX, pillY + pillH, r);
      ctx.arcTo(pillX, pillY + pillH, pillX, pillY, r);
      ctx.arcTo(pillX, pillY, pillX + pillW, pillY, r);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#92400e";
      ctx.font = "bold 11px sans-serif";
      ctx.fillText(pillText, pillX + pillPadX, pillY + 15);
    }

    y += headerH;

    // ── Body: paragraphs, each with colored entity runs ──
    ctx.font = "15px sans-serif";
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      for (const line of block.lines) {
        drawRuns(ctx, tokenizeRuns(line), PADDING, y + 16);
        y += LINE_HEIGHT;
      }
      if (i < blocks.length - 1) y += PARAGRAPH_GAP;
    }
    if (truncated) {
      ctx.fillStyle = "#9ca3af";
      ctx.font = "italic 13px sans-serif";
      ctx.fillText("… continues in note", PADDING, y + 14);
      y += 8;
    }

    if (subContext?.type === "quote" && subBlockH > 0 && (subLines.length > 0 || subImageDims)) {
      y += 12;
      drawSubContext(ctx, subContext, subLines, PADDING, y, CONTENT_WIDTH, subImageDims);
      y += subBlockH;
    }

    // ── Footer: compact, watermark only ──
    ctx.fillStyle = "rgba(0,0,0,0.04)";
    ctx.font = "bold 60px sans-serif";
    ctx.fillText("X", WIDTH - 60, HEIGHT - 12);

    const blob = await canvas.convertToBlob({ type: "image/png" });
    return await blob.arrayBuffer();
  } catch (err: unknown) {
    console.warn("[CardRenderer] Failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}
