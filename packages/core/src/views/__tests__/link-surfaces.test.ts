// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { resolveGalleryCover } from "@/views/gallery-cards";

describe("gallery cover coexistence", () => {
  it("link-only item → link tile", () => {
    expect(resolveGalleryCover({ hasOwnMedia: false, linkUrl: "https://x", linkSite: "x.com", coverImg: "p.jpg" }))
      .toMatchObject({ mode: "linktile", domain: "x.com", badge: true });
  });
  it("item with its own media + a link → media cover + badge", () => {
    expect(resolveGalleryCover({ hasOwnMedia: true, linkUrl: "https://x", linkSite: "x.com", coverImg: "p.jpg" }))
      .toMatchObject({ mode: "media", badge: true });
  });
  it("ordinary media item → plain cover, no badge", () => {
    expect(resolveGalleryCover({ hasOwnMedia: true, linkUrl: null, linkSite: null, coverImg: "p.jpg" }))
      .toMatchObject({ mode: "media", badge: false });
  });
});
