import { describe, it, expect } from "vitest";
import {
  getBookmarkItemId, extractBookmarkText, extractBookmarkAuthor,
  extractBookmarkAuthorUsername, extractBookmarkUrl, type BookmarkRecord,
} from "@/lib/extract";
import { roostNormalize } from "@/lib/normalize";

// Image post. taken_at 1700000000 → 2023-11-14T22:13:20.000Z
const IG_IMG_RAW = {
  code: "Cabc123", pk: "111", media_type: 1, taken_at: 1700000000,
  user: { username: "chef_jane", full_name: "Chef Jane" },
  caption: { text: "Best pasta ever 🍝" },
  like_count: 10, comment_count: 2,
  image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/img1.jpg" }] },
};
const IG_IMG: BookmarkRecord = { platform: "instagram", rawData: IG_IMG_RAW };

describe("Instagram parity (golden — current behavior, must not drift)", () => {
  it("getBookmarkItemId: uses shortcode (code)", () => {
    expect(getBookmarkItemId(IG_IMG)).toBe("Cabc123");
  });
  it("extractBookmarkText: caption.text", () => {
    expect(extractBookmarkText(IG_IMG)).toBe("Best pasta ever 🍝");
  });
  it("extractBookmarkAuthor: user.full_name", () => {
    expect(extractBookmarkAuthor(IG_IMG)).toBe("Chef Jane");
  });
  it("extractBookmarkAuthorUsername: user.username", () => {
    expect(extractBookmarkAuthorUsername(IG_IMG)).toBe("chef_jane");
  });
  it("extractBookmarkUrl: /p/<code>/ url", () => {
    expect(extractBookmarkUrl(IG_IMG)).toBe("https://www.instagram.com/p/Cabc123/");
  });
  it("roostNormalize: id/itemId/published_at", () => {
    expect(roostNormalize("instagram", IG_IMG_RAW)).toMatchObject({
      id: "instagram:Cabc123",
      platform: "instagram",
      itemId: "Cabc123",
      published_at: "2023-11-14T22:13:20.000Z",
      captured_via: "sync",
    });
  });
});
