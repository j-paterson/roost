// @vitest-environment node
import { describe, it, expect } from "vitest";
import { mergeLinkMeta } from "@/sync/link-meta-backfill";

describe("mergeLinkMeta", () => {
  it("fills only the missing fields, never overwrites existing ones", () => {
    const fm = { link_url: "https://example.com/p", link_title: "Kept" };
    const og = { title: "Fetched", description: "Desc", image: "https://example.com/i.jpg", siteName: "example.com" };
    const out = mergeLinkMeta(fm, og);
    expect(out.link_title).toBe("Kept");      // existing preserved
    expect(out.link_desc).toBe("Desc");        // filled
    expect(out.link_site).toBe("example.com"); // filled
    // image is a URL here; the job downloads it and rewrites link_image to a vault path (see runBackfill)
    expect(out.link_image_remote).toBe("https://example.com/i.jpg");
  });

  it("leaves fields missing when OG returned null (item stays in bucket for retry)", () => {
    const out = mergeLinkMeta({ link_url: "https://x" }, { title: null, description: null, image: null, siteName: null });
    expect(out.link_title).toBeUndefined();
  });

  it("does not set link_image_remote when link_image already exists", () => {
    const fm = { link_url: "https://example.com", link_image: "[[existing.jpg]]" };
    const og = { title: "Title", description: "Desc", image: "https://new.jpg", siteName: "example.com" };
    const out = mergeLinkMeta(fm, og);
    expect(out.link_image_remote).toBeUndefined();
    expect(out.link_image).toBeUndefined();
  });

  it("fills all fields when frontmatter has only link_url", () => {
    const fm = { link_url: "https://example.com" };
    const og = { title: "Title", description: "Desc", image: "https://img.jpg", siteName: "Example" };
    const out = mergeLinkMeta(fm, og);
    expect(out.link_title).toBe("Title");
    expect(out.link_desc).toBe("Desc");
    expect(out.link_site).toBe("Example");
    expect(out.link_image_remote).toBe("https://img.jpg");
    expect(out.link_image).toBeUndefined();
  });
});
