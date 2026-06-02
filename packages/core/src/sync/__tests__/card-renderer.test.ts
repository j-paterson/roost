import { describe, it, expect } from "vitest";
import {
  splitParagraphs,
  wrapParagraph,
  tokenizeRuns,
} from "../card-renderer";

// Minimal CtxLike stub — width = 8 px per char so test math is predictable.
function mkCtx(charWidth = 8): { measureText: (s: string) => { width: number } } {
  return { measureText: (s: string) => ({ width: s.length * charWidth }) };
}

describe("splitParagraphs", () => {
  it("returns empty array for empty input", () => {
    expect(splitParagraphs("")).toEqual([]);
  });

  it("splits on blank lines", () => {
    expect(splitParagraphs("hello\n\nworld")).toEqual(["hello", "world"]);
  });

  it("preserves single-newlines as soft line breaks within a paragraph", () => {
    // DOM renderers need this for `>` quote-bullet stacks to display
    // as separate lines. PNG callers flatten them themselves.
    expect(splitParagraphs("line one\nline two\n\npara two")).toEqual([
      "line one\nline two",
      "para two",
    ]);
  });

  it("collapses 3+ consecutive newlines to a single break", () => {
    expect(splitParagraphs("a\n\n\n\nb")).toEqual(["a", "b"]);
  });

  it("normalizes CRLF line endings", () => {
    expect(splitParagraphs("a\r\n\r\nb")).toEqual(["a", "b"]);
  });

  it("drops empty paragraphs", () => {
    expect(splitParagraphs("\n\nhello\n\n")).toEqual(["hello"]);
  });
});

describe("wrapParagraph", () => {
  it("wraps at word boundaries when text exceeds maxWidth", () => {
    // maxWidth=80 px (=10 chars at 8px/char), so "hello world" (11 chars) wraps.
    const { lines, truncated } = wrapParagraph(mkCtx(), "hello world", 80, 10);
    expect(lines).toEqual(["hello", "world"]);
    expect(truncated).toBe(false);
  });

  it("char-breaks a single token wider than maxWidth (URL overflow fix)", () => {
    // maxWidth=80 px (=10 chars), token is 30 chars long — no whitespace to break on.
    const { lines, truncated } = wrapParagraph(
      mkCtx(),
      "https://example.com/very-long-url-with-no-spaces",
      80,
      10,
    );
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      // Each chunk must individually fit within maxWidth.
      expect(line.length * 8).toBeLessThanOrEqual(80);
    }
    expect(truncated).toBe(false);
  });

  it("appends … and reports truncated=true when content exceeds maxLines", () => {
    // 4 separate words at 10-char width can each fit on a line; maxLines=2 cuts it short.
    const { lines, truncated } = wrapParagraph(
      mkCtx(),
      "alpha bravo charlie delta",
      48, // 6 chars per line
      2,
    );
    expect(lines.length).toBe(2);
    expect(lines[1].endsWith("…")).toBe(true);
    expect(truncated).toBe(true);
  });

  it("returns empty + truncated for maxLines<=0 with non-empty text", () => {
    expect(wrapParagraph(mkCtx(), "anything", 80, 0)).toEqual({
      lines: [],
      truncated: true,
    });
  });

  it("handles empty input gracefully", () => {
    expect(wrapParagraph(mkCtx(), "", 80, 10)).toEqual({
      lines: [],
      truncated: false,
    });
  });
});

describe("tokenizeRuns", () => {
  it("emits a single plain run for content without entities", () => {
    expect(tokenizeRuns("just plain text")).toEqual([{ text: "just plain text" }]);
  });

  it("colors @mentions", () => {
    const runs = tokenizeRuns("hi @alice how are you");
    expect(runs).toEqual([
      { text: "hi " },
      { text: "@alice", color: "#1d9bf0" },
      { text: " how are you" },
    ]);
  });

  it("colors #hashtags", () => {
    const runs = tokenizeRuns("love #typescript");
    expect(runs).toEqual([
      { text: "love " },
      { text: "#typescript", color: "#1d9bf0" },
    ]);
  });

  it("colors https:// URLs", () => {
    const runs = tokenizeRuns("see https://example.com/page now");
    expect(runs).toEqual([
      { text: "see " },
      { text: "https://example.com/page", color: "#1d9bf0" },
      { text: " now" },
    ]);
  });

  it("colors bare domain URLs (example.com/path)", () => {
    const runs = tokenizeRuns("read example.com/article");
    expect(runs.find((r) => r.text === "example.com/article")?.color).toBe("#1d9bf0");
  });

  it("handles multiple entities on one line", () => {
    const runs = tokenizeRuns("@bob shared #news at https://x.com/i/status/1");
    const colored = runs.filter((r) => r.color === "#1d9bf0").map((r) => r.text);
    expect(colored).toEqual(["@bob", "#news", "https://x.com/i/status/1"]);
  });

  it("does not color punctuation around entities (entity itself is colored)", () => {
    const runs = tokenizeRuns("(@alice)");
    const handle = runs.find((r) => r.text === "@alice");
    expect(handle?.color).toBe("#1d9bf0");
    expect(runs.some((r) => r.text === "(")).toBe(true);
    expect(runs.some((r) => r.text === ")")).toBe(true);
  });
});
