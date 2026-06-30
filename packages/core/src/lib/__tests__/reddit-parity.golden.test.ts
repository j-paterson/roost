import { describe, it, expect } from "vitest";
import { getBookmarkItemId, extractBookmarkText, extractBookmarkAuthor, extractBookmarkAuthorUsername, extractBookmarkUrl, type BookmarkRecord } from "@/lib/extract";
import { roostNormalize } from "@/lib/normalize";

const RAW = {
  id: "abc123", name: "t3_abc123",
  permalink: "/r/ObsidianMD/comments/abc123/cool_post/",
  title: "Cool post", author: "jane_dev", subreddit: "ObsidianMD",
  created_utc: 1700000000, selftext: "body **md**", is_self: true,
  score: 42, num_comments: 7,
};
const R: BookmarkRecord = { platform: "reddit", rawData: RAW };

describe("Reddit parity (golden — must not drift)", () => {
  it("itemId = base36 id", () => expect(getBookmarkItemId(R)).toBe("abc123"));
  it("text = selftext", () => expect(extractBookmarkText(R)).toBe("body **md**"));
  it("author = author", () => expect(extractBookmarkAuthor(R)).toBe("jane_dev"));
  it("handle = author", () => expect(extractBookmarkAuthorUsername(R)).toBe("jane_dev"));
  it("url from permalink", () => expect(extractBookmarkUrl(R)).toBe("https://www.reddit.com/r/ObsidianMD/comments/abc123/cool_post/"));
  it("normalize id/itemId/published", () => {
    expect(roostNormalize("reddit", RAW)).toMatchObject({ id: "reddit:abc123", platform: "reddit", itemId: "abc123", published_at: "2023-11-14T22:13:20.000Z", captured_via: "sync" });
  });
});
