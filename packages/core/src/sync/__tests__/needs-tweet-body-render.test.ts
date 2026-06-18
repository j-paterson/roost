import { describe, it, expect } from "vitest";
import { needsTweetBodyRender } from "../vault-writer/vault-index";
import { enrichmentVersionField } from "@/lib/enrichments";

const STAMP = enrichmentVersionField("tweetBody"); // "enrichment_v_tweetBody"

describe("needsTweetBodyRender (031 scan predicate)", () => {
  it("flags a Twitter note with no tweetBody stamp", () => {
    expect(needsTweetBodyRender({ platform: "twitter" })).toBe(true);
  });

  it("excludes X Articles (is_article === true) — they already render real markdown", () => {
    expect(needsTweetBodyRender({ platform: "twitter", is_article: true })).toBe(false);
  });

  it("excludes a Twitter note that already carries the stamp", () => {
    expect(needsTweetBodyRender({ platform: "twitter", [STAMP]: 1 })).toBe(false);
  });

  it("excludes non-Twitter notes", () => {
    expect(needsTweetBodyRender({ platform: "tiktok" })).toBe(false);
  });

  it("treats a falsy-but-not-true is_article as still needing render", () => {
    // is_article absent or false must NOT exclude — only an explicit `true` does.
    expect(needsTweetBodyRender({ platform: "twitter", is_article: false })).toBe(true);
  });
});
