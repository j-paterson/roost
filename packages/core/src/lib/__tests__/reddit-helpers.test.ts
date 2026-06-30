// packages/core/src/lib/__tests__/reddit-helpers.test.ts
import { describe, it, expect } from "vitest";
import { extractRedditMedia, buildRedditUrl, redditPreviewToPermanent } from "@/lib/reddit-helpers";
import type { BookmarkRecord } from "@/lib/twitter-helpers";

const rec = (rawData: Record<string, unknown>): BookmarkRecord => ({ platform: "reddit", rawData } as never);

describe("redditPreviewToPermanent", () => {
  it("strips query + converts preview.redd.it → i.redd.it", () => {
    expect(redditPreviewToPermanent("https://preview.redd.it/abc.jpg?width=3000&s=hmac"))
      .toBe("https://i.redd.it/abc.jpg");
  });
});

describe("extractRedditMedia", () => {
  it("self/text post → kind text, no images", () => {
    const r = extractRedditMedia(rec({ is_self: true, selftext: "hi **md**", post_hint: "self" }));
    expect(r.kind).toBe("text"); expect(r.images).toEqual([]); expect(r.videoUrl).toBeNull();
  });

  it("single image post → permanent i.redd.it url", () => {
    const r = extractRedditMedia(rec({ post_hint: "image", url: "https://i.redd.it/x.jpg", url_overridden_by_dest: "https://i.redd.it/x.jpg" }));
    expect(r.kind).toBe("image");
    expect(r.images).toEqual([{ url: "https://i.redd.it/x.jpg", index: 0, ext: "jpg" }]);
  });

  it("gallery → all valid items, sorted by integer id, preview→permanent", () => {
    const r = extractRedditMedia(rec({
      is_gallery: true,
      gallery_data: { items: [{ media_id: "b", id: 2 }, { media_id: "a", id: 1 }] },
      media_metadata: {
        a: { status: "valid", e: "Image", m: "image/jpg", s: { u: "https://preview.redd.it/a.jpg?s=x" } },
        b: { status: "valid", e: "Image", m: "image/png", s: { u: "https://preview.redd.it/b.png?s=y" } },
      },
    }));
    expect(r.kind).toBe("gallery");
    expect(r.images.map(i => i.url)).toEqual(["https://i.redd.it/a.jpg", "https://i.redd.it/b.png"]); // sorted by id 1,2
  });

  it("gallery skips status!=valid", () => {
    const r = extractRedditMedia(rec({
      is_gallery: true,
      gallery_data: { items: [{ media_id: "a", id: 1 }, { media_id: "bad", id: 2 }] },
      media_metadata: { a: { status: "valid", e: "Image", s: { u: "https://i.redd.it/a.jpg" } }, bad: { status: "failed" } },
    }));
    expect(r.images).toHaveLength(1);
  });

  it("v.redd.it video → videoUrl(fallback, stripped) + dashUrl + hasAudio + poster", () => {
    const r = extractRedditMedia(rec({
      is_video: true, post_hint: "hosted:video",
      secure_media: { reddit_video: { fallback_url: "https://v.redd.it/vid1/DASH_1080.mp4?source=fallback", dash_url: "https://v.redd.it/vid1/DASHPlaylist.mpd", has_audio: true, is_gif: false } },
      preview: { images: [{ source: { url: "https://preview.redd.it/p.jpg?s=z" } }] },
    }));
    expect(r.kind).toBe("video");
    expect(r.videoUrl).toBe("https://v.redd.it/vid1/DASH_1080.mp4");
    expect(r.dashUrl).toBe("https://v.redd.it/vid1/DASHPlaylist.mpd");
    expect(r.videoId).toBe("vid1"); expect(r.hasAudio).toBe(true);
    expect(r.coverUrl).toBe("https://i.redd.it/p.jpg");
  });

  it("crosspost → recurses into parent media", () => {
    const r = extractRedditMedia(rec({
      crosspost_parent: "t3_x",
      crosspost_parent_list: [{ post_hint: "image", url: "https://i.redd.it/cp.jpg", url_overridden_by_dest: "https://i.redd.it/cp.jpg" }],
    }));
    expect(r.kind).toBe("image"); expect(r.images[0].url).toBe("https://i.redd.it/cp.jpg");
  });

  it("link post → kind link, url kept, no images", () => {
    const r = extractRedditMedia(rec({ post_hint: "link", url: "https://example.com/article" }));
    expect(r.kind).toBe("link"); expect(r.linkUrl).toBe("https://example.com/article"); expect(r.images).toEqual([]);
  });

  it("removed/deleted self → text, body sentinel preserved (writer decides)", () => {
    const r = extractRedditMedia(rec({ is_self: true, selftext: "[removed]" }));
    expect(r.kind).toBe("text");
  });

  it("null rawData → empty", () => {
    const r = extractRedditMedia({ platform: "reddit", rawData: null } as never);
    expect(r.kind).toBe("link"); expect(r.images).toEqual([]);
  });
});

describe("buildRedditUrl", () => {
  it("prefixes permalink", () => {
    expect(buildRedditUrl("/r/x/comments/abc/title/")).toBe("https://www.reddit.com/r/x/comments/abc/title/");
  });
});
