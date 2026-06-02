// @vitest-environment node
import { describe, it, expect } from "vitest";
import { stripMediaUrls, getTweetMediaUrls } from "../extract";

describe("stripMediaUrls", () => {
  it("strips a single trailing t.co URL", () => {
    const out = stripMediaUrls(
      "Starting a podcast in 2019 https://t.co/Lrx39rXNSp",
      ["https://t.co/Lrx39rXNSp"],
    );
    expect(out).toBe("Starting a podcast in 2019");
  });

  it("strips with leading whitespace + newlines preserved internally", () => {
    const out = stripMediaUrls(
      "Title\n\nbody text https://t.co/abc123",
      ["https://t.co/abc123"],
    );
    expect(out).toBe("Title\n\nbody text");
  });

  it("strips multiple instances when Twitter lists the same URL per gallery item", () => {
    const out = stripMediaUrls(
      "Ardoch House https://t.co/47zv9eTzQY https://t.co/47zv9eTzQY",
      ["https://t.co/47zv9eTzQY", "https://t.co/47zv9eTzQY"],
    );
    expect(out).toBe("Ardoch House");
  });

  it("strips media URL even mid-text (rare but valid)", () => {
    const out = stripMediaUrls(
      "before https://t.co/abc after",
      ["https://t.co/abc"],
    );
    // Strips with leading whitespace, leaves "after" with leading space.
    expect(out).toBe("before after");
  });

  it("leaves text alone when no media URLs", () => {
    const out = stripMediaUrls("Just a plain tweet with no images", []);
    expect(out).toBe("Just a plain tweet with no images");
  });

  it("leaves text alone when media URL not present in text", () => {
    const out = stripMediaUrls(
      "Tweet body without the URL",
      ["https://t.co/notpresent"],
    );
    expect(out).toBe("Tweet body without the URL");
  });

  it("escapes regex metacharacters in URLs", () => {
    // t.co URLs themselves don't contain regex metas, but be safe.
    const out = stripMediaUrls(
      "post https://example.com/foo?bar=1+2",
      ["https://example.com/foo?bar=1+2"],
    );
    expect(out).toBe("post");
  });

  it("does not strip URLs that aren't in the media list (other t.co links survive)", () => {
    const out = stripMediaUrls(
      "Link to article https://t.co/article and image https://t.co/image",
      ["https://t.co/image"],
    );
    expect(out).toBe("Link to article https://t.co/article and image");
  });

  it("returns empty string when input is empty", () => {
    expect(stripMediaUrls("", ["https://t.co/x"])).toBe("");
  });
});

describe("getTweetMediaUrls", () => {
  it("collects from legacy.entities.media", () => {
    const tweet = { legacy: { entities: { media: [{ url: "https://t.co/a" }, { url: "https://t.co/b" }] } } };
    expect(getTweetMediaUrls(tweet)).toEqual(["https://t.co/a", "https://t.co/b"]);
  });

  it("collects from legacy.extended_entities.media", () => {
    const tweet = {
      legacy: {
        extended_entities: { media: [{ url: "https://t.co/x" }, { url: "https://t.co/y" }] },
      },
    };
    expect(getTweetMediaUrls(tweet)).toEqual(["https://t.co/x", "https://t.co/y"]);
  });

  it("merges entities + extended_entities (Twitter often duplicates)", () => {
    const tweet = {
      legacy: {
        entities: { media: [{ url: "https://t.co/a" }] },
        extended_entities: { media: [{ url: "https://t.co/a" }, { url: "https://t.co/b" }] },
      },
    };
    expect(getTweetMediaUrls(tweet)).toEqual([
      "https://t.co/a", "https://t.co/a", "https://t.co/b",
    ]);
  });

  it("returns empty array when no media", () => {
    expect(getTweetMediaUrls({ legacy: { full_text: "no media" } })).toEqual([]);
    expect(getTweetMediaUrls({})).toEqual([]);
    expect(getTweetMediaUrls(null)).toEqual([]);
  });

  it("skips media entries without a url field", () => {
    const tweet = { legacy: { entities: { media: [{}, { url: "https://t.co/ok" }, { url: null }] } } };
    expect(getTweetMediaUrls(tweet)).toEqual(["https://t.co/ok"]);
  });
});
