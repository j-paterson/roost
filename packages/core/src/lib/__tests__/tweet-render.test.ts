import { describe, it, expect } from "vitest";
import { renderTweetBody, isDirectArticle } from "@/lib/tweet-render";
import { extractBookmarkText } from "@/lib/extract";
import type { BookmarkRecord } from "@/lib/extract";

// Fixtures mirror the real rawData shapes parsed by extractBookmarkText /
// extractTwitterMedia (see extract.test.ts + article-extract.test.ts): tweet
// text under legacy.full_text, user under core.user_results.result.core,
// quoted tweet under quoted_status_result.result, article under
// article.article_results.result.
function tweet(rawData: Record<string, unknown>): BookmarkRecord {
  return { platform: "twitter", itemId: "1", rawData } as BookmarkRecord;
}

describe("renderTweetBody — plain text, line breaks, paragraphs", () => {
  it("soft \\n breaks become two-trailing-space hard breaks; blank line splits paragraphs", () => {
    const out = renderTweetBody(
      tweet({ rest_id: "1", legacy: { full_text: "line one\nline two\n\npara two" } }),
    );
    // Two trailing spaces before the soft break (markdown hard break), and a
    // blank-line paragraph split joined with \n\n.
    expect(out).toBe("line one  \nline two\n\npara two");
    // Explicitly assert the mandated two-trailing-spaces format (not a bare \n).
    expect(out).toContain("line one  \n");
  });
});

describe("renderTweetBody — entity linkification", () => {
  it("linkifies @mentions, #hashtags, and URLs", () => {
    const out = renderTweetBody(
      tweet({ rest_id: "1", legacy: { full_text: "hey @alice love #cooking see https://example.com/x" } }),
    );
    expect(out).toContain("[@alice](https://x.com/alice)");
    expect(out).toContain("[#cooking](https://x.com/hashtag/cooking)");
    expect(out).toContain("[https://example.com/x](https://example.com/x)");
  });

  it("linkifies an expanded (t.co-replaced) URL as a markdown link", () => {
    const out = renderTweetBody(
      tweet({
        rest_id: "1",
        legacy: {
          full_text: "check https://t.co/abc now",
          entities: { urls: [{ url: "https://t.co/abc", expanded_url: "https://realsite.com/page" }] },
        },
      }),
    );
    expect(out).toBe("check [https://realsite.com/page](https://realsite.com/page) now");
  });

  it("trims trailing sentence punctuation outside the link", () => {
    const out = renderTweetBody(
      tweet({ rest_id: "1", legacy: { full_text: "go to https://example.com." } }),
    );
    expect(out).toBe("go to [https://example.com](https://example.com).");
  });

  it("percent-encodes a mid-path ) so the markdown link isn't cut short", () => {
    const out = renderTweetBody(
      tweet({ rest_id: "1", legacy: { full_text: "look https://site.com/a)b)c done" } }),
    );
    expect(out).toContain("[https://site.com/a)b)c](https://site.com/a%29b%29c)");
  });

  it("does not linkify an email address (renders it as plain text)", () => {
    const out = renderTweetBody(
      tweet({ rest_id: "1", legacy: { full_text: "reach me at john.doe@example.com please" } }),
    );
    expect(out).toBe("reach me at john.doe@example.com please");
  });
});

describe("renderTweetBody — markdown escaping", () => {
  it("escapes *, _, leading >, and keeps a parenthesized URL link intact", () => {
    const out = renderTweetBody(
      tweet({
        rest_id: "1",
        legacy: { full_text: "*bold* and _x_\n> quote me\nsee https://en.wikipedia.org/wiki/Foo_(bar)" },
      }),
    );
    // Asterisks and underscores escaped so they don't render as emphasis.
    expect(out).toContain("\\*bold\\*");
    expect(out).toContain("\\_x\\_");
    // A leading ">" line is escaped so it doesn't become a stray blockquote.
    expect(out).toContain("\\> quote me");
    // The parenthesized Wikipedia URL link is NOT broken: parens are
    // percent-encoded in the href while the display keeps them literal.
    expect(out).toContain(
      "[https://en.wikipedia.org/wiki/Foo_(bar)](https://en.wikipedia.org/wiki/Foo_%28bar%29)",
    );
  });
});

describe("renderTweetBody — reply context", () => {
  it("prepends a 'Replying to' blockquote for in_reply_to_screen_name", () => {
    const out = renderTweetBody(
      tweet({
        rest_id: "1",
        legacy: { full_text: "totally agree with this", in_reply_to_screen_name: "someone" },
      }),
    );
    expect(out).toBe(
      "> Replying to [@someone](https://x.com/someone)\n\ntotally agree with this",
    );
  });
});

describe("renderTweetBody — quoted tweet", () => {
  it("appends the quoted tweet as a trailing blockquote", () => {
    const out = renderTweetBody(
      tweet({
        rest_id: "1",
        legacy: { full_text: "look at this gem" },
        quoted_status_result: {
          result: {
            rest_id: "999",
            core: { user_results: { result: { core: { name: "Quoted Author", screen_name: "qauthor" } } } },
            legacy: { full_text: "the original quoted text" },
          },
        },
      }),
    );
    expect(out).toBe(
      "look at this gem\n\n> [@qauthor](https://x.com/qauthor)\n> the original quoted text",
    );
  });
});

describe("renderTweetBody — quote-of-article regression", () => {
  it("renders the HOST tweet text (not the quoted article markdown), article as a blockquote", () => {
    const record = tweet({
      rest_id: "1",
      legacy: { full_text: "this article is worth a read" },
      quoted_status_result: {
        result: {
          rest_id: "999",
          core: { user_results: { result: { core: { name: "Writer", screen_name: "writer" } } } },
          legacy: { full_text: "" },
          article: {
            article_results: {
              result: {
                title: "On Pasta",
                content_state: {
                  blocks: [{ key: "a", type: "unstyled", text: "Pasta is delicious.", depth: 0, inlineStyleRanges: [], entityRanges: [] }],
                  entityMap: [],
                },
              },
            },
          },
        },
      },
    });
    const out = renderTweetBody(record);
    // Host text MUST be present.
    expect(out).toContain("this article is worth a read");
    // It must NOT be treated as a direct article.
    expect(isDirectArticle(record)).toBe(false);
    // The body must start with the host text, not the article markdown.
    expect(out.startsWith("this article is worth a read")).toBe(true);
    // The quoted article appears as a blockquote (lines prefixed with "> ").
    expect(out).toContain("> [@writer](https://x.com/writer)");
    expect(out).toContain("> Pasta is delicious.");
  });
});

describe("renderTweetBody — thread", () => {
  it("renders each main segment, joined with \\n\\n---\\n\\n", () => {
    const out = renderTweetBody(
      tweet({
        rest_id: "1",
        legacy: { full_text: "first tweet of the thread" },
        _thread: [
          { rest_id: "1", raw: { rest_id: "1", legacy: { full_text: "first tweet of the thread" } } },
          { rest_id: "2", raw: { rest_id: "2", legacy: { full_text: "second tweet here" } } },
        ],
      }),
    );
    expect(out).toBe("first tweet of the thread\n\n---\n\nsecond tweet here");
  });

  it("appends a quoted thread under a '**Quoted thread:**' heading", () => {
    const out = renderTweetBody(
      tweet({
        rest_id: "1",
        legacy: { full_text: "main" },
        _thread: [
          { rest_id: "1", raw: { rest_id: "1", legacy: { full_text: "main one" } } },
          { rest_id: "2", raw: { rest_id: "2", legacy: { full_text: "main two" } } },
        ],
        _quoted_thread: [
          { rest_id: "9", raw: { rest_id: "9", legacy: { full_text: "quoted one" } } },
          { rest_id: "10", raw: { rest_id: "10", legacy: { full_text: "quoted two" } } },
        ],
      }),
    );
    expect(out).toBe(
      "main one\n\n---\n\nmain two\n\n**Quoted thread:**\n\nquoted one\n\n---\n\nquoted two",
    );
  });
});

describe("renderTweetBody — direct-article regression", () => {
  it("returns extractBookmarkText(record) byte-identical for a direct article", () => {
    const record = tweet({
      rest_id: "1",
      legacy: { full_text: "" },
      article: {
        article_results: {
          result: {
            title: "On Pasta",
            content_state: {
              blocks: [{ key: "a", type: "unstyled", text: "Pasta is delicious.", depth: 0, inlineStyleRanges: [], entityRanges: [] }],
              entityMap: [],
            },
          },
        },
      },
    });
    expect(isDirectArticle(record)).toBe(true);
    expect(renderTweetBody(record)).toBe(extractBookmarkText(record));
  });
});

describe("renderTweetBody — mediaEmbeds option", () => {
  it("appends a given embed below the text, blank-line separated", () => {
    const out = renderTweetBody(
      tweet({ rest_id: "1", legacy: { full_text: "hello world" } }),
      { mediaEmbeds: ["![[Bookmarks/X/twitter-1/1.jpg]]"] },
    );
    expect(out).toBe("hello world\n\n![[Bookmarks/X/twitter-1/1.jpg]]");
  });

  it("joins multiple embeds with a single \\n (one per line)", () => {
    const out = renderTweetBody(
      tweet({ rest_id: "1", legacy: { full_text: "hello world" } }),
      { mediaEmbeds: ["![[Bookmarks/X/twitter-1/1.jpg]]", "![[Bookmarks/X/twitter-1/2.jpg]]"] },
    );
    expect(out).toBe(
      "hello world\n\n![[Bookmarks/X/twitter-1/1.jpg]]\n![[Bookmarks/X/twitter-1/2.jpg]]",
    );
  });

  it("no embeds (undefined / empty / {}) is identical to the no-arg render", () => {
    const t = tweet({ rest_id: "1", legacy: { full_text: "hey @alice see #cooking" } });
    const base = renderTweetBody(t);
    expect(renderTweetBody(t, { mediaEmbeds: [] })).toBe(base);
    expect(renderTweetBody(t, {})).toBe(base);
    // A whitespace-only embed line is filtered out (treated as no embed).
    expect(renderTweetBody(t, { mediaEmbeds: ["   "] })).toBe(base);
  });

  it("media-only tweet (empty text) → the embed is the whole body, no leading blank line", () => {
    const out = renderTweetBody(
      tweet({ rest_id: "1", legacy: { full_text: "" } }),
      { mediaEmbeds: ["![[Bookmarks/X/twitter-1/1.jpg]]"] },
    );
    expect(out).toBe("![[Bookmarks/X/twitter-1/1.jpg]]");
  });

  it("a direct article IGNORES mediaEmbeds (byte-identical to extractBookmarkText)", () => {
    const record = tweet({
      rest_id: "1",
      legacy: { full_text: "" },
      article: {
        article_results: {
          result: {
            title: "On Pasta",
            content_state: {
              blocks: [{ key: "a", type: "unstyled", text: "Pasta is delicious.", depth: 0, inlineStyleRanges: [], entityRanges: [] }],
              entityMap: [],
            },
          },
        },
      },
    });
    expect(isDirectArticle(record)).toBe(true);
    const out = renderTweetBody(record, { mediaEmbeds: ["![[x.jpg]]"] });
    expect(out).toBe(extractBookmarkText(record));
    expect(out).not.toContain("![[x.jpg]]");
  });
});
