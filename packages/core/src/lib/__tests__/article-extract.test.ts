import { describe, it, expect } from "vitest";
import {
  extractArticleContent,
  normalizeEntityMap,
  renderArticleNoteBody,
  renderArticleStubBody,
  type ArticleResultRaw,
  type RawDraftBlock,
} from "@/lib/article-extract";

describe("normalizeEntityMap", () => {
  it("converts Twitter array form to standard object form", () => {
    const input = [
      { key: 0, value: { type: "LINK", data: { url: "https://example.com" } } },
      { key: 1, value: { type: "MEDIA", data: {} } },
    ];
    expect(normalizeEntityMap(input)).toEqual({
      "0": { type: "LINK", data: { url: "https://example.com" } },
      "1": { type: "MEDIA", data: {} },
    });
  });

  it("passes through standard object form unchanged", () => {
    const input = {
      "0": { type: "LINK", data: { url: "https://example.com" } },
    };
    expect(normalizeEntityMap(input)).toEqual(input);
  });

  it("returns empty object for null/undefined/non-object inputs", () => {
    expect(normalizeEntityMap(null)).toEqual({});
    expect(normalizeEntityMap(undefined)).toEqual({});
    expect(normalizeEntityMap("not an entity map")).toEqual({});
    expect(normalizeEntityMap(42)).toEqual({});
  });

  it("skips array entries with undefined keys", () => {
    const input = [
      { key: 0, value: { type: "LINK" } },
      { value: { type: "MEDIA" } } as { key?: number; value: { type: string } },
    ];
    expect(normalizeEntityMap(input)).toEqual({
      "0": { type: "LINK" },
    });
  });

  it("skips array entries with undefined or null value", () => {
    const input = [
      { key: 0, value: { type: "LINK" } },
      { key: 1 } as { key: number; value?: unknown },
      { key: 2, value: null } as { key: number; value: null },
    ];
    expect(normalizeEntityMap(input)).toEqual({
      "0": { type: "LINK" },
    });
  });
});

describe("extractArticleContent — guard rails", () => {
  it("returns null when input is null", () => {
    expect(extractArticleContent(null as unknown as ArticleResultRaw)).toBeNull();
  });

  it("returns null when content_state is missing", () => {
    expect(extractArticleContent({
      title: "T",
      preview_text: "P",
    } as unknown as ArticleResultRaw)).toBeNull();
  });

  it("returns null when content_state.blocks is missing", () => {
    expect(extractArticleContent({
      title: "T",
      preview_text: "P",
      content_state: { entityMap: [] },
    } as unknown as ArticleResultRaw)).toBeNull();
  });

  it("returns null when content_state.blocks is empty", () => {
    expect(extractArticleContent({
      title: "T",
      preview_text: "P",
      content_state: { blocks: [], entityMap: [] },
    } as unknown as ArticleResultRaw)).toBeNull();
  });

  it("returns ArticleContent shape for a single empty unstyled block", () => {
    const result = extractArticleContent({
      title: "Test Article",
      preview_text: "Preview",
      content_state: {
        blocks: [
          { key: "a", type: "unstyled", text: "", depth: 0, inlineStyleRanges: [], entityRanges: [] },
        ],
        entityMap: [],
      },
    } as unknown as ArticleResultRaw);
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Test Article");
    expect(result!.body).toBe("");
    expect(result!.coverImageUrl).toBeNull();
    expect(result!.publishedAtSecs).toBeNull();
    expect(result!.wordCount).toBe(0);
  });

  it("populates coverImageUrl from cover_media.media_info.original_img_url", () => {
    const result = extractArticleContent({
      title: "T",
      preview_text: "P",
      cover_media: { media_info: { original_img_url: "https://pbs.twimg.com/media/abc.jpg" } },
      content_state: {
        blocks: [{ key: "a", type: "unstyled", text: "x", depth: 0, inlineStyleRanges: [], entityRanges: [] }],
        entityMap: [],
      },
    } as unknown as ArticleResultRaw);
    expect(result!.coverImageUrl).toBe("https://pbs.twimg.com/media/abc.jpg");
  });

  it("populates publishedAtSecs from metadata.first_published_at_secs", () => {
    const result = extractArticleContent({
      title: "T",
      preview_text: "P",
      metadata: { first_published_at_secs: 1714492800 },
      content_state: {
        blocks: [{ key: "a", type: "unstyled", text: "x", depth: 0, inlineStyleRanges: [], entityRanges: [] }],
        entityMap: [],
      },
    } as unknown as ArticleResultRaw);
    expect(result!.publishedAtSecs).toBe(1714492800);
  });
});

function makeArticle(blocks: RawDraftBlock[]): ArticleResultRaw {
  return {
    title: "T",
    preview_text: "P",
    content_state: { blocks, entityMap: [] },
  };
}

function block(type: string, text: string, depth = 0): RawDraftBlock {
  return { key: "k_" + type + "_" + text.slice(0, 4), type, text, depth, inlineStyleRanges: [], entityRanges: [] };
}

describe("extractArticleContent — block rendering", () => {
  it("renders unstyled blocks as paragraphs separated by blank lines", () => {
    const r = extractArticleContent(makeArticle([
      block("unstyled", "First paragraph."),
      block("unstyled", "Second paragraph."),
    ]));
    expect(r!.body).toBe("First paragraph.\n\nSecond paragraph.");
  });

  it("renders header blocks with # prefix per level", () => {
    const r = extractArticleContent(makeArticle([
      block("header-one", "H1"),
      block("header-two", "H2"),
      block("header-three", "H3"),
    ]));
    expect(r!.body).toBe("# H1\n\n## H2\n\n### H3");
  });

  it("renders unordered-list-item with - prefix and depth indentation", () => {
    const r = extractArticleContent(makeArticle([
      block("unordered-list-item", "Top", 0),
      block("unordered-list-item", "Nested", 1),
      block("unordered-list-item", "Deep", 2),
    ]));
    expect(r!.body).toBe("- Top\n  - Nested\n    - Deep");
  });

  it("renders ordered-list-item with 1. prefix per item", () => {
    const r = extractArticleContent(makeArticle([
      block("ordered-list-item", "First"),
      block("ordered-list-item", "Second"),
    ]));
    expect(r!.body).toBe("1. First\n1. Second");
  });

  it("renders blockquote with > prefix per line", () => {
    const r = extractArticleContent(makeArticle([
      block("blockquote", "Two-line\nquote"),
    ]));
    expect(r!.body).toBe("> Two-line\n> quote");
  });

  it("renders consecutive code-blocks as a single fenced block", () => {
    const r = extractArticleContent(makeArticle([
      block("code-block", "function foo() {"),
      block("code-block", "  return 1;"),
      block("code-block", "}"),
    ]));
    expect(r!.body).toBe("```\nfunction foo() {\n  return 1;\n}\n```");
  });

  it("separates non-code blocks before and after a code-block", () => {
    const r = extractArticleContent(makeArticle([
      block("unstyled", "Before"),
      block("code-block", "code"),
      block("unstyled", "After"),
    ]));
    expect(r!.body).toBe("Before\n\n```\ncode\n```\n\nAfter");
  });

  it("treats unknown block types as plain paragraphs", () => {
    const r = extractArticleContent(makeArticle([
      block("totally-bogus-type", "Unknown but renderable."),
    ]));
    expect(r!.body).toBe("Unknown but renderable.");
  });

  it("counts words after rendering", () => {
    const r = extractArticleContent(makeArticle([
      block("unstyled", "Three words here."),
      block("header-one", "Two more"),
    ]));
    expect(r!.wordCount).toBe(5);
  });
});

function blockWithStyles(text: string, ranges: { offset: number; length: number; style: string }[]): RawDraftBlock {
  return { key: "k", type: "unstyled", text, depth: 0, inlineStyleRanges: ranges, entityRanges: [] };
}

describe("extractArticleContent — inline styles", () => {
  it("wraps BOLD ranges in **", () => {
    const r = extractArticleContent(makeArticle([
      blockWithStyles("Hello bold world.", [{ offset: 6, length: 4, style: "BOLD" }]),
    ]));
    expect(r!.body).toBe("Hello **bold** world.");
  });

  it("wraps ITALIC ranges in *", () => {
    const r = extractArticleContent(makeArticle([
      blockWithStyles("Be italic now.", [{ offset: 3, length: 6, style: "ITALIC" }]),
    ]));
    expect(r!.body).toBe("Be *italic* now.");
  });

  it("wraps CODE ranges in backticks", () => {
    const r = extractArticleContent(makeArticle([
      blockWithStyles("Use foo() here.", [{ offset: 4, length: 5, style: "CODE" }]),
    ]));
    expect(r!.body).toBe("Use `foo()` here.");
  });

  it("wraps STRIKETHROUGH ranges in ~~", () => {
    const r = extractArticleContent(makeArticle([
      blockWithStyles("Old idea now.", [{ offset: 0, length: 8, style: "STRIKETHROUGH" }]),
    ]));
    expect(r!.body).toBe("~~Old idea~~ now.");
  });

  it("nests overlapping BOLD + ITALIC deterministically (** outside, * inside)", () => {
    const r = extractArticleContent(makeArticle([
      blockWithStyles("bold-italic word", [
        { offset: 0, length: 11, style: "BOLD" },
        { offset: 5, length: 6, style: "ITALIC" },
      ]),
    ]));
    expect(r!.body).toBe("**bold-*italic*** word");
  });

  it("ignores unknown style names", () => {
    const r = extractArticleContent(makeArticle([
      blockWithStyles("Hello world.", [{ offset: 0, length: 5, style: "MARQUEE" }]),
    ]));
    expect(r!.body).toBe("Hello world.");
  });

  it("handles styles inside list items", () => {
    const r = extractArticleContent(makeArticle([
      { key: "a", type: "unordered-list-item", text: "bold item", depth: 0,
        inlineStyleRanges: [{ offset: 0, length: 4, style: "BOLD" }], entityRanges: [] },
    ]));
    expect(r!.body).toBe("- **bold** item");
  });

  it("handles styles inside headers", () => {
    const r = extractArticleContent(makeArticle([
      { key: "a", type: "header-two", text: "italic header", depth: 0,
        inlineStyleRanges: [{ offset: 0, length: 6, style: "ITALIC" }], entityRanges: [] },
    ]));
    expect(r!.body).toBe("## *italic* header");
  });
});

function articleWithEntities(
  blocks: RawDraftBlock[],
  entityMap: { key: number; value: { type: string; data?: Record<string, unknown> } }[],
): ArticleResultRaw {
  return {
    title: "T",
    preview_text: "P",
    content_state: { blocks, entityMap },
  };
}

describe("extractArticleContent — entity rendering", () => {
  it("renders a LINK entity range as [text](url)", () => {
    const r = extractArticleContent(articleWithEntities(
      [{
        key: "a", type: "unstyled", text: "Click here for more.", depth: 0,
        inlineStyleRanges: [],
        entityRanges: [{ offset: 6, length: 4, key: 0 }],
      }],
      [{ key: 0, value: { type: "LINK", data: { url: "https://example.com" } } }],
    ));
    expect(r!.body).toBe("Click [here](https://example.com) for more.");
  });

  it("renders an atomic block with MEDIA entity as ![alt](url)", () => {
    const r = extractArticleContent(articleWithEntities(
      [{
        key: "a", type: "atomic", text: " ", depth: 0,
        inlineStyleRanges: [],
        entityRanges: [{ offset: 0, length: 1, key: 0 }],
      }],
      [{ key: 0, value: { type: "MEDIA", data: { url: "https://pbs.twimg.com/media/abc.jpg", alt: "An image" } } }],
    ));
    expect(r!.body).toBe("![An image](https://pbs.twimg.com/media/abc.jpg)");
  });

  it("renders an atomic MEDIA without alt as ![](url)", () => {
    const r = extractArticleContent(articleWithEntities(
      [{ key: "a", type: "atomic", text: " ", depth: 0, inlineStyleRanges: [],
         entityRanges: [{ offset: 0, length: 1, key: 0 }] }],
      [{ key: 0, value: { type: "MEDIA", data: { url: "https://pbs.twimg.com/x.jpg" } } }],
    ));
    expect(r!.body).toBe("![](https://pbs.twimg.com/x.jpg)");
  });

  it("falls through MEDIA in a non-atomic block to a link", () => {
    const r = extractArticleContent(articleWithEntities(
      [{ key: "a", type: "unstyled", text: "see image", depth: 0, inlineStyleRanges: [],
         entityRanges: [{ offset: 4, length: 5, key: 0 }] }],
      [{ key: 0, value: { type: "MEDIA", data: { url: "https://pbs.twimg.com/x.jpg" } } }],
    ));
    expect(r!.body).toBe("see [image](https://pbs.twimg.com/x.jpg)");
  });

  it("renders TWEMOJI entity as passthrough text (the unicode is in block.text)", () => {
    const r = extractArticleContent(articleWithEntities(
      [{ key: "a", type: "unstyled", text: "I love 🚀 rockets", depth: 0, inlineStyleRanges: [],
         entityRanges: [{ offset: 7, length: 1, key: 0 }] }],
      [{ key: 0, value: { type: "TWEMOJI", data: {} } }],
    ));
    expect(r!.body).toBe("I love 🚀 rockets");
  });

  it("renders MARKDOWN entity as passthrough text (already markdown)", () => {
    const r = extractArticleContent(articleWithEntities(
      [{ key: "a", type: "unstyled", text: "raw `inline` md", depth: 0, inlineStyleRanges: [],
         entityRanges: [{ offset: 4, length: 8, key: 0 }] }],
      [{ key: 0, value: { type: "MARKDOWN", data: {} } }],
    ));
    expect(r!.body).toBe("raw `inline` md");
  });

  it("ignores unknown entity types", () => {
    const r = extractArticleContent(articleWithEntities(
      [{ key: "a", type: "unstyled", text: "Hello world", depth: 0, inlineStyleRanges: [],
         entityRanges: [{ offset: 0, length: 5, key: 0 }] }],
      [{ key: 0, value: { type: "DOOHICKEY", data: {} } }],
    ));
    expect(r!.body).toBe("Hello world");
  });

  it("renders array-shape entityMap (Twitter quirk)", () => {
    const r = extractArticleContent(articleWithEntities(
      [{ key: "a", type: "unstyled", text: "Click", depth: 0, inlineStyleRanges: [],
         entityRanges: [{ offset: 0, length: 5, key: 7 }] }],
      [
        { key: 0, value: { type: "LINK", data: { url: "https://wrong.example" } } },
        { key: 7, value: { type: "LINK", data: { url: "https://correct.example" } } },
      ],
    ));
    expect(r!.body).toBe("[Click](https://correct.example)");
  });

  it("combines LINK with BOLD inline style — link wraps styled text", () => {
    const r = extractArticleContent(articleWithEntities(
      [{ key: "a", type: "unstyled", text: "Bold link", depth: 0,
         inlineStyleRanges: [{ offset: 0, length: 4, style: "BOLD" }],
         entityRanges: [{ offset: 0, length: 9, key: 0 }] }],
      [{ key: 0, value: { type: "LINK", data: { url: "https://example.com" } } }],
    ));
    expect(r!.body).toBe("[**Bold** link](https://example.com)");
  });

  it("combines LINK with BOLD when entity starts after unstyled prefix", () => {
    const r = extractArticleContent(articleWithEntities(
      [{ key: "a", type: "unstyled", text: "see bold now", depth: 0,
         inlineStyleRanges: [{ offset: 4, length: 4, style: "BOLD" }],
         entityRanges: [{ offset: 4, length: 4, key: 0 }] }],
      [{ key: 0, value: { type: "LINK", data: { url: "https://example.com" } } }],
    ));
    expect(r!.body).toBe("see [**bold**](https://example.com) now");
  });

  it("combines LINK with CODE when entity starts after unstyled prefix", () => {
    const r = extractArticleContent(articleWithEntities(
      [{ key: "a", type: "unstyled", text: "use foo() here", depth: 0,
         inlineStyleRanges: [{ offset: 4, length: 5, style: "CODE" }],
         entityRanges: [{ offset: 4, length: 5, key: 0 }] }],
      [{ key: 0, value: { type: "LINK", data: { url: "https://example.com" } } }],
    ));
    expect(r!.body).toBe("use [`foo()`](https://example.com) here");
  });
});

describe("renderArticleNoteBody", () => {
  it("renders title + cover + body", () => {
    const out = renderArticleNoteBody({
      title: "On Pasta",
      body: "Pasta is great.",
      coverImageUrl: "https://pbs.twimg.com/cover.jpg",
      wordCount: 3,
      publishedAtSecs: null,
    });
    expect(out).toBe("# On Pasta\n\n![cover](https://pbs.twimg.com/cover.jpg)\n\nPasta is great.");
  });

  it("omits cover image when coverImageUrl is null", () => {
    const out = renderArticleNoteBody({
      title: "Untitled",
      body: "Hello",
      coverImageUrl: null,
      wordCount: 1,
      publishedAtSecs: null,
    });
    expect(out).toBe("# Untitled\n\nHello");
  });

  it("emits only title + cover when body is empty", () => {
    const out = renderArticleNoteBody({
      title: "T",
      body: "",
      coverImageUrl: "https://pbs.twimg.com/c.jpg",
      wordCount: 0,
      publishedAtSecs: null,
    });
    expect(out).toBe("# T\n\n![cover](https://pbs.twimg.com/c.jpg)");
  });
});

describe("renderArticleStubBody", () => {
  it("renders title + cover + preview as blockquote + footer", () => {
    const out = renderArticleStubBody({
      title: "On Pasta",
      preview_text: "Italian pasta is...",
      cover_media: { media_info: { original_img_url: "https://pbs.twimg.com/cover.jpg" } },
    });
    expect(out).toBe(
      "# On Pasta\n\n" +
      "![cover](https://pbs.twimg.com/cover.jpg)\n\n" +
      "> Italian pasta is...\n\n" +
      "*Article body not yet fetched.*"
    );
  });

  it("omits cover when missing", () => {
    const out = renderArticleStubBody({
      title: "T",
      preview_text: "P",
    });
    expect(out).toBe("# T\n\n> P\n\n*Article body not yet fetched.*");
  });

  it("falls back to '(untitled)' when title is missing", () => {
    const out = renderArticleStubBody({
      preview_text: "P",
    });
    expect(out).toBe("# (untitled)\n\n> P\n\n*Article body not yet fetched.*");
  });

  it("handles empty preview gracefully", () => {
    const out = renderArticleStubBody({
      title: "T",
      preview_text: "",
    });
    expect(out).toBe("# T\n\n*Article body not yet fetched.*");
  });
});
