// @vitest-environment node
import { describe, it, expect } from "vitest";
import { needsArticleBodyBackfill, getArticleResultFromRaw, articleHostTweetId } from "../article-utils";

describe("needsArticleBodyBackfill", () => {
  it("returns false for a non-article tweet", () => {
    const raw = { rest_id: "1", legacy: { full_text: "hello" } };
    expect(needsArticleBodyBackfill(raw)).toBe(false);
  });

  it("returns true for a direct article stub without content_state", () => {
    const raw = {
      rest_id: "1",
      article: {
        article_results: {
          result: { title: "X Article", preview_text: "preview…" },
        },
      },
    };
    expect(needsArticleBodyBackfill(raw)).toBe(true);
  });

  it("returns false when the article already has content_state", () => {
    const raw = {
      rest_id: "1",
      article: {
        article_results: {
          result: { title: "X Article", content_state: { blocks: [] } },
        },
      },
    };
    expect(needsArticleBodyBackfill(raw)).toBe(false);
  });

  it("detects article inside quoted_status_result", () => {
    const raw = {
      rest_id: "1",
      quoted_status_result: {
        result: {
          rest_id: "2",
          article: {
            article_results: {
              result: { title: "Quoted X Article" },
            },
          },
        },
      },
    };
    expect(needsArticleBodyBackfill(raw)).toBe(true);
  });

  it("returns false when quoted article already has content_state", () => {
    const raw = {
      rest_id: "1",
      quoted_status_result: {
        result: {
          article: {
            article_results: {
              result: { content_state: { blocks: [] } },
            },
          },
        },
      },
    };
    expect(needsArticleBodyBackfill(raw)).toBe(false);
  });

  it("safely handles null / non-object input", () => {
    expect(needsArticleBodyBackfill(null)).toBe(false);
    expect(needsArticleBodyBackfill(undefined)).toBe(false);
    expect(needsArticleBodyBackfill("string")).toBe(false);
    expect(needsArticleBodyBackfill(42)).toBe(false);
  });
});

describe("getArticleResultFromRaw", () => {
  it("returns the direct article when present", () => {
    const result = { title: "T" };
    const raw = { article: { article_results: { result } } };
    expect(getArticleResultFromRaw(raw)).toBe(result);
  });

  it("returns the quoted article when no direct article", () => {
    const result = { title: "Q" };
    const raw = { quoted_status_result: { result: { article: { article_results: { result } } } } };
    expect(getArticleResultFromRaw(raw)).toBe(result);
  });

  it("returns null when no article anywhere", () => {
    expect(getArticleResultFromRaw({ rest_id: "1" })).toBe(null);
  });
});

describe("articleHostTweetId", () => {
  it("returns the bookmark's own rest_id for a direct article", () => {
    const raw = { rest_id: "100", article: { article_results: { result: {} } } };
    expect(articleHostTweetId(raw)).toBe("100");
  });

  it("returns the quoted tweet's rest_id for a quoted article", () => {
    const raw = {
      rest_id: "100",
      quoted_status_result: { result: { rest_id: "200", article: { article_results: { result: {} } } } },
    };
    expect(articleHostTweetId(raw)).toBe("200");
  });
});
