// @vitest-environment node
import { describe, it, expect } from "vitest";
import { needsLinkMeta } from "@/sync/vault-writer/vault-index";

describe("needsLinkMeta", () => {
  it("true when link_url present but title/desc/image missing", () => {
    expect(needsLinkMeta({ link_url: "https://x.com/a" })).toBe(true);
    expect(needsLinkMeta({ link_url: "https://x.com/a", link_title: "T" })).toBe(true); // still missing desc+image
  });
  it("false when fully populated", () => {
    expect(needsLinkMeta({ link_url: "https://x.com/a", link_title: "T", link_desc: "D", link_image: "[[p]]" })).toBe(false);
  });
  it("false when not a link bookmark", () => {
    expect(needsLinkMeta({})).toBe(false);
  });
});
