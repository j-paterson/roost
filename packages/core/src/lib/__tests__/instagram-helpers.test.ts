import { describe, it, expect } from "vitest";
import { extractInstagramMedia, buildInstagramUrl } from "@/lib/instagram-helpers";
import type { BookmarkRecord } from "@/lib/twitter-helpers";

const IMG: BookmarkRecord = {
  platform: "instagram",
  rawData: {
    code: "Cabc123",
    media_type: 1,
    like_count: 10,
    comment_count: 2,
    image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/img1.jpg", width: 1080 }] },
    _roost_collections: ["Recipes"],
  },
};

const VIDEO: BookmarkRecord = {
  platform: "instagram",
  rawData: {
    code: "Cvid456",
    media_type: 2,
    like_count: 5,
    comment_count: 1,
    image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/poster.jpg" }] },
    video_versions: [{ url: "https://scontent.cdninstagram.com/v.mp4", type: 101 }],
    _roost_collections: [],
  },
};

const CAROUSEL: BookmarkRecord = {
  platform: "instagram",
  rawData: {
    code: "Ccar789",
    media_type: 8,
    carousel_media: [
      { media_type: 1, image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/c1.jpg" }] } },
      { media_type: 2,
        image_versions2: { candidates: [{ url: "https://scontent.cdninstagram.com/c2-poster.jpg" }] },
        video_versions: [{ url: "https://scontent.cdninstagram.com/c2.mp4" }] },
    ],
  },
};

describe("extractInstagramMedia", () => {
  it("type 1 image post", () => {
    expect(extractInstagramMedia(IMG)).toEqual({
      images: [{ url: "https://scontent.cdninstagram.com/img1.jpg", index: 0 }],
      videoUrl: null,
      coverUrl: "https://scontent.cdninstagram.com/img1.jpg",
      mediaType: 1,
      isCarousel: false,
      carousel: [],
      collections: ["Recipes"],
      stats: { likes: 10, comments: 2 },
    });
  });

  it("type 2 video post uses video url + image cover", () => {
    const r = extractInstagramMedia(VIDEO);
    expect(r.videoUrl).toBe("https://scontent.cdninstagram.com/v.mp4");
    expect(r.coverUrl).toBe("https://scontent.cdninstagram.com/poster.jpg");
    expect(r.mediaType).toBe(2);
    expect(r.images).toEqual([]);
  });

  it("type 8 carousel walks children by their own media_type", () => {
    const r = extractInstagramMedia(CAROUSEL);
    expect(r.isCarousel).toBe(true);
    expect(r.carousel).toEqual([
      { type: 1, url: "https://scontent.cdninstagram.com/c1.jpg", coverUrl: null, index: 0 },
      { type: 2, url: "https://scontent.cdninstagram.com/c2.mp4", coverUrl: "https://scontent.cdninstagram.com/c2-poster.jpg", index: 1 },
    ]);
    expect(r.coverUrl).toBe("https://scontent.cdninstagram.com/c1.jpg");
  });

  it("missing rawData → empty result", () => {
    const r = extractInstagramMedia({ platform: "instagram", rawData: null } as unknown as BookmarkRecord);
    expect(r.images).toEqual([]);
    expect(r.collections).toEqual([]);
    expect(r.stats).toBeNull();
  });
});

describe("buildInstagramUrl", () => {
  it("builds a /p/<code>/ url", () => {
    expect(buildInstagramUrl("Cabc123")).toBe("https://www.instagram.com/p/Cabc123/");
  });
});
