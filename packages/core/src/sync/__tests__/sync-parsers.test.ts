/**
 * Characterization tests for sync parser seams — pure functions with zero I/O.
 *
 * Covers:
 *   1. roostNormalize("tiktok", ...) — item-id extraction, epoch parsing, null guards
 *   2. roostNormalize("twitter", ...) + roostUnwrapTweet — wrapper unwrapping,
 *      id extraction, date parsing, null guards
 *   3. isSelfThreadTail, getTweetAuthorId, getConversationId, threadAnchor —
 *      self-thread detection and the seam that drives runThreadBackfill queuing
 *
 * All tests use hand-built minimal inputs. No mocks, no I/O, no webview.
 *
 * See plans/023-sync-parser-tests.md for the full plan.
 */
import { describe, it, expect } from "vitest";
import { roostNormalize, roostUnwrapTweet } from "@/lib/normalize";
import {
  isSelfThreadTail,
  getTweetAuthorId,
  getConversationId,
} from "@/lib/extract";
import { threadAnchor } from "../thread-fetcher";

// ── Shared fixture shapes ──────────────────────────────────────────────────────

/** Minimal TikTok video raw object — matches videoCache shape from tiktok-probe. */
const tikRaw = {
  id: "7123456789012345678",
  createTime: 1700000000, // epoch seconds (Nov 2023)
  desc: "Test video #hashtag",
  author: { uniqueId: "testuser", nickname: "Test User" },
  video: { id: "7123456789012345678", playAddr: "https://example.com/video.mp4" },
};

/** Bare tweet — has __typename + rest_id + legacy. */
const bareTweet = {
  __typename: "Tweet",
  rest_id: "1234567890",
  legacy: {
    id_str: "1234567890",
    created_at: "Mon Jan 01 00:00:00 +0000 2024",
    full_text: "Hello world",
    conversation_id_str: "1234567890",
    user_id_str: "author_1",
  },
  core: { user_results: { result: { rest_id: "author_1" } } },
};

/** TweetWithVisibilityResults wrapper — common in Bookmarks API. */
const wrappedTweet = {
  __typename: "TweetWithVisibilityResults",
  tweet: { ...bareTweet },
};

/** result-nested shape — GraphQL data.tweetResult.result. */
const nestedTweet = { result: { ...bareTweet } };

/** Thread tail: rest_id !== conversation_id_str, in_reply_to is self. */
const selfThreadTail = {
  rest_id: "9999",
  legacy: {
    conversation_id_str: "1111",
    in_reply_to_user_id_str: "author_42",
    user_id_str: "author_42",
    created_at: "Mon Jan 01 00:00:00 +0000 2024",
  },
  core: { user_results: { result: { rest_id: "author_42" } } },
};

/** Thread root: rest_id === conversation_id_str, has replies. */
const threadRoot = {
  rest_id: "1111",
  legacy: {
    conversation_id_str: "1111",
    reply_count: 3,
    user_id_str: "author_42",
  },
};

/** Single tweet: no replies. */
const singleTweet = {
  rest_id: "2222",
  legacy: {
    conversation_id_str: "2222",
    reply_count: 0,
    user_id_str: "author_42",
  },
};

/** Reply to a different user (not a self-thread tail). */
const replyToOther = {
  rest_id: "3333",
  legacy: {
    conversation_id_str: "1111",
    in_reply_to_user_id_str: "other_user",
    user_id_str: "author_42",
  },
};

// ── 1. roostNormalize — TikTok path ───────────────────────────────────────────

describe("roostNormalize — tiktok", () => {
  it("returns a NormalizedRecord with correct platform, itemId, and composite id", () => {
    const result = roostNormalize("tiktok", tikRaw, { capturedVia: "sync" });
    expect(result).not.toBeNull();
    expect(result!.platform).toBe("tiktok");
    expect(result!.itemId).toBe("7123456789012345678");
    expect(result!.id).toBe("tiktok:7123456789012345678");
    expect(result!.captured_via).toBe("sync");
  });

  it("resolves itemId from video.id when top-level id is absent", () => {
    const result = roostNormalize("tiktok", { video: { id: "alt_id" }, createTime: 1700000000 }, {});
    expect(result).not.toBeNull();
    expect(result!.itemId).toBe("alt_id");
    expect(result!.id).toBe("tiktok:alt_id");
  });

  it("returns null when neither id nor video.id is present", () => {
    const result = roostNormalize("tiktok", { desc: "no id" }, {});
    expect(result).toBeNull();
  });

  it("returns published_at as null when createTime is 0 (below epoch threshold)", () => {
    const result = roostNormalize("tiktok", { id: "x", createTime: 0 }, {});
    expect(result).not.toBeNull();
    expect(result!.published_at).toBeNull();
  });

  it("parses a second-epoch createTime into a non-null ISO published_at", () => {
    const result = roostNormalize("tiktok", { id: "x", createTime: 1700000000 }, {});
    expect(result).not.toBeNull();
    expect(result!.published_at).not.toBeNull();
    expect(() => new Date(result!.published_at!).toISOString()).not.toThrow();
  });

  it("handles millisecond-epoch createTime (> 1e12) producing a non-null published_at", () => {
    const result = roostNormalize("tiktok", { id: "x", createTime: 1700000000000 }, {});
    expect(result).not.toBeNull();
    expect(result!.published_at).not.toBeNull();
  });

  it("passes through custom capturedVia option", () => {
    const result = roostNormalize("tiktok", tikRaw, { capturedVia: "manual" });
    expect(result!.captured_via).toBe("manual");
  });
});

// ── 2a. roostUnwrapTweet ──────────────────────────────────────────────────────

describe("roostUnwrapTweet", () => {
  it("returns the object itself for a bare tweet with rest_id and legacy", () => {
    const result = roostUnwrapTweet(bareTweet);
    expect(result).toBe(bareTweet);
  });

  it("unwraps TweetWithVisibilityResults to the inner tweet", () => {
    const result = roostUnwrapTweet(wrappedTweet);
    expect(result).toEqual(bareTweet);
  });

  it("recursively unwraps a result-nested shape", () => {
    const result = roostUnwrapTweet(nestedTweet);
    expect(result).toEqual(bareTweet);
  });

  it("returns null for null input", () => {
    expect(roostUnwrapTweet(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(roostUnwrapTweet(undefined)).toBeNull();
  });

  it("returns null for empty object (no recognizable tweet shape)", () => {
    expect(roostUnwrapTweet({})).toBeNull();
  });

  it("falls back to .tweet when no __typename is present but .tweet.rest_id exists", () => {
    const noTypename = { tweet: { rest_id: "x", legacy: {} } };
    const result = roostUnwrapTweet(noTypename);
    expect(result).toEqual(noTypename.tweet);
  });
});

// ── 2b. roostNormalize — Twitter path ─────────────────────────────────────────

describe("roostNormalize — twitter", () => {
  it("returns a NormalizedRecord with correct id, itemId, platform for a bare tweet", () => {
    const result = roostNormalize("twitter", bareTweet, {});
    expect(result).not.toBeNull();
    expect(result!.platform).toBe("twitter");
    expect(result!.itemId).toBe("1234567890");
    expect(result!.id).toBe("twitter:1234567890");
  });

  it("unwraps TweetWithVisibilityResults and extracts the correct itemId", () => {
    const result = roostNormalize("twitter", wrappedTweet, {});
    expect(result).not.toBeNull();
    expect(result!.itemId).toBe("1234567890");
  });

  it("parses created_at into a non-null ISO published_at string", () => {
    const result = roostNormalize("twitter", bareTweet, {});
    expect(result).not.toBeNull();
    expect(result!.published_at).not.toBeNull();
    expect(() => new Date(result!.published_at!).toISOString()).not.toThrow();
  });

  it("returns null when neither rest_id nor legacy.id_str is present", () => {
    const result = roostNormalize("twitter", { legacy: { full_text: "no id" } }, {});
    expect(result).toBeNull();
  });

  it("falls back to legacy.id_str when rest_id is absent on the raw object", () => {
    const rawWithLegacyId = {
      legacy: { id_str: "legacy_id", created_at: "Mon Jan 01 00:00:00 +0000 2024" },
    };
    const result = roostNormalize("twitter", rawWithLegacyId, {});
    expect(result).not.toBeNull();
    expect(result!.itemId).toBe("legacy_id");
  });

  it("stored captured_via defaults to sync when not provided", () => {
    const result = roostNormalize("twitter", bareTweet, {});
    expect(result!.captured_via).toBe("sync");
  });
});

// ── 3a. isSelfThreadTail ──────────────────────────────────────────────────────

describe("isSelfThreadTail", () => {
  it("returns true for a tail tweet where rest_id !== conversation_id and in_reply_to is self", () => {
    expect(isSelfThreadTail(selfThreadTail)).toBe(true);
  });

  it("returns false for a single tweet where rest_id === conversation_id", () => {
    expect(isSelfThreadTail(singleTweet)).toBe(false);
  });

  it("returns false when in_reply_to_user_id_str is a different user", () => {
    expect(isSelfThreadTail(replyToOther)).toBe(false);
  });

  it("returns false for a thread root (rest_id === conversation_id)", () => {
    expect(isSelfThreadTail(threadRoot)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isSelfThreadTail(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isSelfThreadTail(undefined)).toBe(false);
  });

  it("returns false when in_reply_to_user_id_str is absent", () => {
    const noReplyField = {
      rest_id: "5555",
      legacy: {
        conversation_id_str: "1111",
        user_id_str: "author_42",
        // no in_reply_to_user_id_str
      },
    };
    expect(isSelfThreadTail(noReplyField)).toBe(false);
  });
});

// ── 3b. getTweetAuthorId ──────────────────────────────────────────────────────

describe("getTweetAuthorId", () => {
  it("returns core.user_results.result.rest_id when present (preferred path)", () => {
    const tweet = {
      core: { user_results: { result: { rest_id: "core_author" } } },
      legacy: { user_id_str: "legacy_author" },
    };
    expect(getTweetAuthorId(tweet)).toBe("core_author");
  });

  it("falls back to legacy.user_id_str when core path is absent", () => {
    const tweet = { legacy: { user_id_str: "legacy_author" } };
    expect(getTweetAuthorId(tweet)).toBe("legacy_author");
  });

  it("returns null for null input", () => {
    expect(getTweetAuthorId(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(getTweetAuthorId(undefined)).toBeNull();
  });

  it("returns null when no author field exists on the object", () => {
    expect(getTweetAuthorId({ rest_id: "x" })).toBeNull();
  });
});

// ── 3c. getConversationId ─────────────────────────────────────────────────────

describe("getConversationId", () => {
  it("returns legacy.conversation_id_str when present", () => {
    const tweet = { legacy: { conversation_id_str: "conv_123" } };
    expect(getConversationId(tweet)).toBe("conv_123");
  });

  it("returns null when the field is absent", () => {
    expect(getConversationId({ rest_id: "x" })).toBeNull();
  });

  it("returns null for null input", () => {
    expect(getConversationId(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(getConversationId(undefined)).toBeNull();
  });
});

// ── 3d. threadAnchor ──────────────────────────────────────────────────────────

describe("threadAnchor", () => {
  it("returns anchor info for a self-thread tail with all required fields", () => {
    const result = threadAnchor(selfThreadTail);
    expect(result).toEqual({
      focalTweetId: "9999",
      authorId: "author_42",
      conversationId: "1111",
    });
  });

  it("returns null for a single tweet (not a self-thread tail)", () => {
    expect(threadAnchor(singleTweet)).toBeNull();
  });

  it("returns null for a thread root (rest_id === conversation_id_str)", () => {
    expect(threadAnchor(threadRoot)).toBeNull();
  });

  it("returns null for a reply to a different user", () => {
    expect(threadAnchor(replyToOther)).toBeNull();
  });

  it("returns null for null input", () => {
    expect(threadAnchor(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(threadAnchor(undefined)).toBeNull();
  });

  it("returns null when tweet has rest_id but no extractable author", () => {
    const noAuthor = {
      rest_id: "4444",
      legacy: {
        conversation_id_str: "1111",
        in_reply_to_user_id_str: "author_42",
        // no user_id_str, no core path
      },
    };
    // in_reply_to equals "author_42" but getTweetAuthorId will return null
    // since there's no user_id_str or core path — isSelfThreadTail returns false
    expect(threadAnchor(noAuthor)).toBeNull();
  });

  it("unwraps TweetWithVisibilityResults before evaluating thread anchor", () => {
    const wrappedTail = {
      __typename: "TweetWithVisibilityResults",
      tweet: { ...selfThreadTail },
    };
    const result = threadAnchor(wrappedTail);
    expect(result).toEqual({
      focalTweetId: "9999",
      authorId: "author_42",
      conversationId: "1111",
    });
  });
});
