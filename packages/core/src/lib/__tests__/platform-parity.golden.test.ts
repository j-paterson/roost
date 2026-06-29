/**
 * Golden / characterization tests — platform-parity net.
 *
 * These tests PIN the CURRENT output of every parser and normalizer function
 * for representative TikTok and X/Twitter raw records. They exist so that the
 * upcoming refactor (Tasks 3-8, per-platform parsing moved into descriptors)
 * cannot silently change behaviour. If a test here breaks, the refactor drifted.
 *
 * DO NOT modify assertions to make a refactor pass. Only update assertions when
 * the source intentionally changes observed behaviour AND a reviewer has approved.
 */
import { describe, it, expect } from "vitest";
import {
  getBookmarkItemId,
  extractBookmarkText,
  extractBookmarkAuthor,
  extractBookmarkAuthorUsername,
  extractBookmarkUrl,
  extractTikTokMedia,
  extractTikTokSubtitleUrl,
  extractTwitterMedia,
  type BookmarkRecord,
} from "@/lib/extract";
import { roostNormalize } from "@/lib/normalize";

// ── TikTok fixture 1 ─────────────────────────────────────────────────────────
// Video post with sound, stats, hashtags, and subtitles.
// itemId resolved via top-level raw.id (primary branch).
// createTime 1700000000 → 2023-11-14T22:13:20.000Z
const TT1_RAW = {
  id: "7123456789012345678",
  desc: "Check out this awesome video #fyp #dance",
  createTime: 1700000000,
  author: {
    uniqueId: "dancemaster99",
    nickname: "Dance Master",
  },
  video: {
    playAddr: "https://v19.tiktokcdn.com/video/tos/abc.mp4",
    originCover: "https://p16.tiktokcdn.com/img/tos/cover.jpeg",
    id: "7123456789012345678",
    subtitleInfos: [
      {
        Url: "https://sf3.tiktokcdn.com/subtitle/asr.vtt",
        Source: "ASR",
        LanguageCodeName: "eng-US",
      },
      {
        Url: "https://sf3.tiktokcdn.com/subtitle/creator.vtt",
        Source: "Creator",
        LanguageCodeName: "eng-US",
      },
    ],
  },
  music: { title: "Original Sound", authorName: "Dance Master" },
  stats: {
    playCount: 100000,
    diggCount: 5000,
    commentCount: 200,
    shareCount: 300,
    collectCount: 150,
  },
  challenges: [{ title: "fyp" }, { title: "dance" }],
};
const TT1: BookmarkRecord = { platform: "tiktok", rawData: TT1_RAW };

// ── TikTok fixture 2 ─────────────────────────────────────────────────────────
// Photo-carousel post (no top-level id — resolved via raw.video.id, secondary
// branch). No subtitleInfos on the video object.
// createTime 1710000000 → 2024-03-09T16:00:00.000Z
const TT2_RAW = {
  desc: "Beautiful photos from my trip ✈️",
  createTime: 1710000000,
  author: {
    uniqueId: "traveler_jane",
    nickname: "Jane Traveler",
  },
  // No top-level id — itemId must fall through to video.id
  video: { id: "7987654321098765432" },
  imagePost: {
    images: [
      { imageURL: { urlList: ["https://p16.tiktokcdn.com/img/tos/photo1.jpeg"] } },
      { imageURL: "https://p16.tiktokcdn.com/img/tos/photo2.jpeg" },
    ],
  },
  music: { title: "Travel Vibes", authorName: "Music Artist" },
  stats: {
    playCount: 50000,
    diggCount: 3000,
    commentCount: 100,
    shareCount: 200,
    collectCount: 80,
  },
};
const TT2: BookmarkRecord = { platform: "tiktok", rawData: TT2_RAW };

// ── Twitter fixture 1 ─────────────────────────────────────────────────────────
// Plain tweet, new schema (name / screen_name on user.core, not user.legacy).
// Has a t.co URL that gets expanded in extractBookmarkText.
// created_at "Wed Jan 15 12:00:00 +0000 2025" → 2025-01-15T12:00:00.000Z
const TW1_RAW = {
  rest_id: "1234567890123456789",
  core: {
    user_results: {
      result: {
        rest_id: "111111111",
        core: {
          name: "Alice Developer",
          screen_name: "alicedev",
        },
        legacy: {
          followers_count: 5000,
        },
      },
    },
  },
  legacy: {
    id_str: "1234567890123456789",
    full_text: "This is a test tweet with a URL https://t.co/abc123",
    created_at: "Wed Jan 15 12:00:00 +0000 2025",
    entities: {
      urls: [
        {
          url: "https://t.co/abc123",
          expanded_url: "https://example.com/article",
        },
      ],
      media: [],
    },
    extended_entities: { media: [] },
  },
};
const TW1: BookmarkRecord = { platform: "twitter", rawData: TW1_RAW };

// ── Twitter fixture 2 ─────────────────────────────────────────────────────────
// Tweet with a photo attachment, legacy schema (name / screen_name on
// user.legacy, no user.core object). The t.co media URL is stripped from text.
// created_at "Mon Mar 10 08:30:00 +0000 2025" → 2025-03-10T08:30:00.000Z
const TW2_RAW = {
  rest_id: "9876543210987654321",
  core: {
    user_results: {
      result: {
        rest_id: "222222222",
        // No .core on user — falls back to .legacy
        legacy: {
          name: "Bob Photographer",
          screen_name: "bobphoto",
          followers_count: 2000,
        },
      },
    },
  },
  legacy: {
    id_str: "9876543210987654321",
    full_text: "My latest shot 📷 https://t.co/photo1",
    created_at: "Mon Mar 10 08:30:00 +0000 2025",
    entities: {
      urls: [],
      media: [
        {
          url: "https://t.co/photo1",
          media_url_https: "https://pbs.twimg.com/media/abc.jpg",
          type: "photo",
        },
      ],
    },
    extended_entities: {
      media: [
        {
          url: "https://t.co/photo1",
          media_url_https: "https://pbs.twimg.com/media/abc.jpg",
          type: "photo",
        },
      ],
    },
  },
};
const TW2: BookmarkRecord = { platform: "twitter", rawData: TW2_RAW };

// ─────────────────────────────────────────────────────────────────────────────

describe("platform parity (golden — current behavior, must not drift)", () => {
  // ── TikTok ──────────────────────────────────────────────────────────────────

  describe("TikTok — TT1: video with sound, stats, subtitles", () => {
    it("getBookmarkItemId: uses raw.id (primary branch)", () => {
      expect(getBookmarkItemId(TT1)).toBe("7123456789012345678");
    });

    it("extractBookmarkText: returns raw.desc", () => {
      expect(extractBookmarkText(TT1)).toBe("Check out this awesome video #fyp #dance");
    });

    it("extractBookmarkAuthor: returns author.nickname", () => {
      expect(extractBookmarkAuthor(TT1)).toBe("Dance Master");
    });

    it("extractBookmarkAuthorUsername: returns author.uniqueId", () => {
      expect(extractBookmarkAuthorUsername(TT1)).toBe("dancemaster99");
    });

    it("extractBookmarkUrl: constructs TikTok video URL", () => {
      expect(extractBookmarkUrl(TT1)).toBe(
        "https://www.tiktok.com/@dancemaster99/video/7123456789012345678",
      );
    });

    it("extractTikTokMedia: video, sound, stats, hashtags", () => {
      expect(extractTikTokMedia(TT1)).toEqual({
        images: [],
        videoUrl: "https://v19.tiktokcdn.com/video/tos/abc.mp4",
        coverUrl: "https://p16.tiktokcdn.com/img/tos/cover.jpeg",
        sound: { title: "Original Sound", author: "Dance Master" },
        stats: { plays: 100000, likes: 5000, comments: 200, shares: 300, saves: 150 },
        hashtags: ["fyp", "dance"],
        collection: null,
      });
    });

    it("extractTikTokSubtitleUrl: prefers Creator > ASR source", () => {
      // Creator + English = score 5, ASR + English = score 3
      expect(extractTikTokSubtitleUrl(TT1)).toBe(
        "https://sf3.tiktokcdn.com/subtitle/creator.vtt",
      );
    });

    it("roostNormalize: produces correct id, itemId, published_at", () => {
      expect(roostNormalize("tiktok", TT1_RAW)).toMatchObject({
        id: "tiktok:7123456789012345678",
        platform: "tiktok",
        itemId: "7123456789012345678",
        published_at: "2023-11-14T22:13:20.000Z",
        saved_at: "2023-11-14T22:13:20.000Z",
        captured_via: "sync",
      });
    });
  });

  describe("TikTok — TT2: photo carousel, itemId from video.id", () => {
    it("getBookmarkItemId: falls through to raw.video.id when no raw.id", () => {
      expect(getBookmarkItemId(TT2)).toBe("7987654321098765432");
    });

    it("extractBookmarkText: returns raw.desc with emoji", () => {
      expect(extractBookmarkText(TT2)).toBe("Beautiful photos from my trip ✈️");
    });

    it("extractBookmarkAuthor: returns author.nickname", () => {
      expect(extractBookmarkAuthor(TT2)).toBe("Jane Traveler");
    });

    it("extractBookmarkAuthorUsername: returns author.uniqueId", () => {
      expect(extractBookmarkAuthorUsername(TT2)).toBe("traveler_jane");
    });

    it("extractBookmarkUrl: constructs TikTok video URL using video.id", () => {
      expect(extractBookmarkUrl(TT2)).toBe(
        "https://www.tiktok.com/@traveler_jane/video/7987654321098765432",
      );
    });

    it("extractTikTokMedia: photos from imagePost.images, both URL shapes", () => {
      expect(extractTikTokMedia(TT2)).toEqual({
        images: [
          { url: "https://p16.tiktokcdn.com/img/tos/photo1.jpeg", index: 0 },
          { url: "https://p16.tiktokcdn.com/img/tos/photo2.jpeg", index: 1 },
        ],
        videoUrl: null,
        coverUrl: null,
        sound: { title: "Travel Vibes", author: "Music Artist" },
        stats: { plays: 50000, likes: 3000, comments: 100, shares: 200, saves: 80 },
        hashtags: [],
        collection: null,
      });
    });

    it("extractTikTokSubtitleUrl: null when no subtitleInfos", () => {
      expect(extractTikTokSubtitleUrl(TT2)).toBeNull();
    });

    it("roostNormalize: produces correct id, itemId, published_at", () => {
      expect(roostNormalize("tiktok", TT2_RAW)).toMatchObject({
        id: "tiktok:7987654321098765432",
        platform: "tiktok",
        itemId: "7987654321098765432",
        published_at: "2024-03-09T16:00:00.000Z",
        saved_at: "2024-03-09T16:00:00.000Z",
        captured_via: "sync",
      });
    });
  });

  // ── Twitter / X ──────────────────────────────────────────────────────────────

  describe("Twitter — TW1: plain tweet, new schema (name on user.core)", () => {
    it("getBookmarkItemId: uses raw.rest_id", () => {
      expect(getBookmarkItemId(TW1)).toBe("1234567890123456789");
    });

    it("extractBookmarkText: expands t.co URL, strips nothing (no media)", () => {
      expect(extractBookmarkText(TW1)).toBe(
        "This is a test tweet with a URL https://example.com/article",
      );
    });

    it("extractBookmarkAuthor: reads name from user.core (new schema)", () => {
      expect(extractBookmarkAuthor(TW1)).toBe("Alice Developer");
    });

    it("extractBookmarkAuthorUsername: reads screen_name from user.core (new schema)", () => {
      expect(extractBookmarkAuthorUsername(TW1)).toBe("alicedev");
    });

    it("extractBookmarkUrl: constructs x.com status URL", () => {
      expect(extractBookmarkUrl(TW1)).toBe(
        "https://x.com/alicedev/status/1234567890123456789",
      );
    });

    it("extractTwitterMedia: all null/empty when no media or card", () => {
      expect(extractTwitterMedia(TW1)).toEqual({
        photos: [],
        videoUrl: null,
        videoPosterUrl: null,
        cardMeta: null,
        quotedTweet: null,
        replyTo: null,
        folder: null,
      });
    });

    it("roostNormalize: correct id, itemId, published_at", () => {
      expect(roostNormalize("twitter", TW1_RAW)).toMatchObject({
        id: "twitter:1234567890123456789",
        platform: "twitter",
        itemId: "1234567890123456789",
        published_at: "2025-01-15T12:00:00.000Z",
        saved_at: "2025-01-15T12:00:00.000Z",
        captured_via: "sync",
      });
    });
  });

  describe("Twitter — TW2: photo tweet, legacy schema (name on user.legacy)", () => {
    it("getBookmarkItemId: uses raw.rest_id", () => {
      expect(getBookmarkItemId(TW2)).toBe("9876543210987654321");
    });

    it("extractBookmarkText: strips trailing media t.co URL", () => {
      // "My latest shot 📷 https://t.co/photo1" → media URL stripped → trimmed
      expect(extractBookmarkText(TW2)).toBe("My latest shot 📷");
    });

    it("extractBookmarkAuthor: falls back to user.legacy.name when no user.core", () => {
      expect(extractBookmarkAuthor(TW2)).toBe("Bob Photographer");
    });

    it("extractBookmarkAuthorUsername: falls back to user.legacy.screen_name when no user.core", () => {
      expect(extractBookmarkAuthorUsername(TW2)).toBe("bobphoto");
    });

    it("extractBookmarkUrl: constructs x.com status URL using legacy schema author", () => {
      expect(extractBookmarkUrl(TW2)).toBe(
        "https://x.com/bobphoto/status/9876543210987654321",
      );
    });

    it("extractTwitterMedia: extracts photo from extended_entities with format suffix", () => {
      expect(extractTwitterMedia(TW2)).toEqual({
        photos: [
          { url: "https://pbs.twimg.com/media/abc.jpg?format=jpg&name=large", index: 0 },
        ],
        videoUrl: null,
        videoPosterUrl: null,
        cardMeta: null,
        quotedTweet: null,
        replyTo: null,
        folder: null,
      });
    });

    it("roostNormalize: correct id, itemId, published_at", () => {
      expect(roostNormalize("twitter", TW2_RAW)).toMatchObject({
        id: "twitter:9876543210987654321",
        platform: "twitter",
        itemId: "9876543210987654321",
        published_at: "2025-03-10T08:30:00.000Z",
        saved_at: "2025-03-10T08:30:00.000Z",
        captured_via: "sync",
      });
    });
  });
});
