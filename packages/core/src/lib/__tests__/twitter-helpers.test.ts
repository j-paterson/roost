// @vitest-environment node
import { describe, it, expect } from "vitest";
import { extractTwitterLink } from "@/lib/twitter-helpers";
import type { BookmarkRecord } from "@/lib/twitter-helpers";

/** Tweet with an external link + card metadata. */
const WITH_LINK: BookmarkRecord = {
  platform: "twitter",
  rawData: {
    legacy: {
      entities: {
        urls: [
          {
            url: "https://t.co/abc123",
            expanded_url: "https://arxiv.org/abs/2401.00001",
          },
        ],
      },
      full_text: "Great paper https://t.co/abc123",
    },
    card: {
      legacy: {
        binding_values: [
          { key: "title", value: { string_value: "Paper Title" } },
          { key: "description", value: { string_value: "A paper about things." } },
          {
            key: "thumbnail_image_original",
            value: { image_value: { url: "https://cdn.arxiv.org/thumb.jpg" } },
          },
        ],
      },
    },
  } as never,
};

/** Tweet with a link whose t.co also appears in the media list — should be excluded. */
const MEDIA_ONLY: BookmarkRecord = {
  platform: "twitter",
  rawData: {
    legacy: {
      entities: {
        urls: [
          {
            url: "https://t.co/media1",
            expanded_url: "https://pic.twitter.com/xyz",
          },
        ],
        media: [{ url: "https://t.co/media1" }],
      },
      full_text: "Look at this photo https://t.co/media1",
    },
  } as never,
};

/** Tweet with no URLs at all. */
const NO_URLS: BookmarkRecord = {
  platform: "twitter",
  rawData: {
    legacy: {
      entities: {
        urls: [],
      },
      full_text: "Just a thought.",
    },
  } as never,
};

describe("extractTwitterLink", () => {
  it("returns a LinkCard with url, title, description, image, siteName when card data present", () => {
    const card = extractTwitterLink(WITH_LINK);
    expect(card).not.toBeNull();
    expect(card?.url).toBe("https://arxiv.org/abs/2401.00001");
    expect(card?.title).toBe("Paper Title");
    expect(card?.description).toBe("A paper about things.");
    expect(card?.image).toBe("https://cdn.arxiv.org/thumb.jpg");
    expect(card?.siteName).toBe("arxiv.org");
  });

  it("returns null when all urls are media t.co URLs (excluded by getTweetMediaUrls)", () => {
    expect(extractTwitterLink(MEDIA_ONLY)).toBeNull();
  });

  it("returns null when tweet has no external urls", () => {
    expect(extractTwitterLink(NO_URLS)).toBeNull();
  });
});
