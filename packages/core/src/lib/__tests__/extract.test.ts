import { describe, it, expect } from "vitest";
import {
  extractBookmarkText,
  extractBookmarkAuthor,
  extractBookmarkAuthorUsername,
} from "@/lib/extract";
import { articleFrontmatterFields } from "@/sync/vault-writer";

describe("extractBookmarkText — article handling", () => {
  it("renders full article body when content_state is present", () => {
    const record = {
      itemId: "123",
      rawData: {
        rest_id: "123",
        legacy: { full_text: "" },
        article: {
          article_results: {
            result: {
              title: "On Pasta",
              preview_text: "Pasta is...",
              content_state: {
                blocks: [
                  {
                    key: "a",
                    type: "unstyled",
                    text: "Pasta is delicious.",
                    depth: 0,
                    inlineStyleRanges: [],
                    entityRanges: [],
                  },
                ],
                entityMap: [],
              },
            },
          },
        },
      },
    } as const;
    const out = extractBookmarkText(
      record as Parameters<typeof extractBookmarkText>[0],
    );
    expect(out).toContain("# On Pasta");
    expect(out).toContain("Pasta is delicious.");
  });

  it("renders stub body when article_results has no content_state", () => {
    const record = {
      itemId: "123",
      rawData: {
        rest_id: "123",
        legacy: { full_text: "" },
        article: {
          article_results: {
            result: {
              title: "On Pasta",
              preview_text: "Pasta is...",
              cover_media: {
                media_info: {
                  original_img_url: "https://pbs.twimg.com/c.jpg",
                },
              },
            },
          },
        },
      },
    } as const;
    const out = extractBookmarkText(
      record as Parameters<typeof extractBookmarkText>[0],
    );
    expect(out).toBe(
      "# On Pasta\n\n" +
        "![cover](https://pbs.twimg.com/c.jpg)\n\n" +
        "> Pasta is...\n\n" +
        "*Article body not yet fetched.*",
    );
  });

  it("handles article nested under quoted_status_result", () => {
    const record = {
      itemId: "999",
      rawData: {
        rest_id: "999",
        legacy: { full_text: "Check this out" },
        quoted_status_result: {
          result: {
            article: {
              article_results: {
                result: {
                  title: "Quoted Article",
                  preview_text: "Brief",
                },
              },
            },
          },
        },
      },
    } as const;
    const out = extractBookmarkText(
      record as Parameters<typeof extractBookmarkText>[0],
    );
    expect(out).toContain("# Quoted Article");
    expect(out).toContain("> Brief");
  });

  it("falls through to legacy.full_text when no article_results present", () => {
    const record = {
      itemId: "111",
      rawData: {
        rest_id: "111",
        legacy: { full_text: "Just a regular tweet body." },
      },
    } as const;
    const out = extractBookmarkText(
      record as Parameters<typeof extractBookmarkText>[0],
    );
    expect(out).toBe("Just a regular tweet body.");
  });
});

describe("articleFrontmatterFields", () => {
  it("returns is_article=true + title + word_count when content_state present", () => {
    const fields = articleFrontmatterFields({
      article: {
        article_results: {
          result: {
            title: "On Pasta",
            preview_text: "P",
            content_state: {
              blocks: [
                { key: "a", type: "unstyled", text: "Three short words", depth: 0,
                  inlineStyleRanges: [], entityRanges: [] },
              ],
              entityMap: [],
            },
          },
        },
      },
    });
    expect(fields.is_article).toBe(true);
    expect(fields.article_title).toBe("On Pasta");
    expect(fields.word_count).toBe(3);
    expect(fields.article_fetch_failed).toBeUndefined();
  });

  it("returns article_fetch_failed=true when content_state is missing", () => {
    const fields = articleFrontmatterFields({
      article: {
        article_results: {
          result: { title: "T", preview_text: "P" },
        },
      },
    });
    expect(fields.article_fetch_failed).toBe(true);
    expect(fields.word_count).toBeUndefined();
  });

  it("returns empty object when there's no article", () => {
    expect(articleFrontmatterFields({ legacy: { full_text: "tweet" } })).toEqual({});
  });

  it("includes article_published_at when metadata.first_published_at_secs present", () => {
    const fields = articleFrontmatterFields({
      article: {
        article_results: {
          result: {
            title: "T",
            metadata: { first_published_at_secs: 1714492800 },
            content_state: { blocks: [{ key: "a", type: "unstyled", text: "x", depth: 0, inlineStyleRanges: [], entityRanges: [] }], entityMap: [] },
          },
        },
      },
    });
    expect(fields.article_published_at).toBe("2024-04-30T16:00:00.000Z");
  });

  it("handles article under quoted_status_result", () => {
    const fields = articleFrontmatterFields({
      quoted_status_result: {
        result: {
          article: {
            article_results: {
              result: { title: "Quoted Article" },
            },
          },
        },
      },
    });
    expect(fields.is_article).toBe(true);
    expect(fields.article_title).toBe("Quoted Article");
  });
});

describe("extractBookmarkAuthor — Twitter schema variants", () => {
  // ── New schema (Q1 2026): name/screen_name moved to user.core ──
  const newSchema = {
    platform: "twitter",
    itemId: "1",
    rawData: {
      rest_id: "1",
      core: {
        user_results: {
          result: {
            core: { name: "Kevin Simback 🍷", screen_name: "KSimback" },
            legacy: { followers_count: 100 },
          },
        },
      },
      legacy: { full_text: "hi" },
    },
  } as Parameters<typeof extractBookmarkAuthor>[0];

  // ── Legacy schema (pre-migration): name/screen_name still on user.legacy ──
  const legacySchema = {
    platform: "twitter",
    itemId: "2",
    rawData: {
      rest_id: "2",
      core: {
        user_results: {
          result: {
            legacy: { name: "Old Schema", screen_name: "oldhandle" },
          },
        },
      },
      legacy: { full_text: "hi" },
    },
  } as Parameters<typeof extractBookmarkAuthor>[0];

  it("reads display name from user.core (new schema)", () => {
    expect(extractBookmarkAuthor(newSchema)).toBe("Kevin Simback 🍷");
  });

  it("reads screen_name from user.core (new schema)", () => {
    expect(extractBookmarkAuthorUsername(newSchema)).toBe("KSimback");
  });

  it("falls back to user.legacy when user.core lacks the field (old raw.json)", () => {
    expect(extractBookmarkAuthor(legacySchema)).toBe("Old Schema");
    expect(extractBookmarkAuthorUsername(legacySchema)).toBe("oldhandle");
  });

  it("returns Unknown when neither schema has the author", () => {
    const empty = {
      platform: "twitter",
      itemId: "3",
      rawData: {
        rest_id: "3",
        core: { user_results: { result: { core: {}, legacy: {} } } },
        legacy: { full_text: "hi" },
      },
    } as Parameters<typeof extractBookmarkAuthor>[0];
    expect(extractBookmarkAuthor(empty)).toBe("Unknown");
    expect(extractBookmarkAuthorUsername(empty)).toBeNull();
  });
});
