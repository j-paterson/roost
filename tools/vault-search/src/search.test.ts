import { describe, it, expect } from "vitest";
import { sanitizeFtsQuery } from "./search";

describe("sanitizeFtsQuery (FTS5 input hardening)", () => {
  it("passes through ordinary multi-word queries unchanged", () => {
    expect(sanitizeFtsQuery("science fiction novels")).toBe("science fiction novels");
  });

  it("strips hyphens so 'cross-chain' isn't parsed as 'cross NOT chain'", () => {
    // Regression for the runtime error: "no such column: chain"
    expect(sanitizeFtsQuery("cryptocurrency bridge cross-chain")).toBe("cryptocurrency bridge cross chain");
  });

  it("strips FTS5 syntax characters", () => {
    expect(sanitizeFtsQuery('search "with" quotes')).toBe("search with quotes");
    expect(sanitizeFtsQuery("col:value")).toBe("col value");
    expect(sanitizeFtsQuery("foo*")).toBe("foo");
    expect(sanitizeFtsQuery("(group) [brackets] {braces}")).toBe("group brackets braces");
  });

  it("removes standalone boolean operators", () => {
    expect(sanitizeFtsQuery("apple AND banana")).toBe("apple banana");
    expect(sanitizeFtsQuery("apple OR banana")).toBe("apple banana");
    expect(sanitizeFtsQuery("apple NOT banana")).toBe("apple banana");
    expect(sanitizeFtsQuery("apple NEAR banana")).toBe("apple banana");
  });

  it("preserves lowercase 'and'/'or' as part of normal language", () => {
    // FTS5 operators are case-sensitive, so lowercase shouldn't be stripped
    expect(sanitizeFtsQuery("salt and pepper")).toBe("salt and pepper");
  });

  it("collapses runs of whitespace and trims", () => {
    expect(sanitizeFtsQuery("  many   spaces  ")).toBe("many spaces");
  });

  it("returns empty string for queries that reduce to nothing", () => {
    expect(sanitizeFtsQuery("")).toBe("");
    expect(sanitizeFtsQuery("()[]{}")).toBe("");
    expect(sanitizeFtsQuery("AND OR NOT")).toBe("");
  });

  it("preserves apostrophes (for possessives)", () => {
    expect(sanitizeFtsQuery("user's notes")).toBe("user's notes");
  });

  it("preserves unicode/diacritics", () => {
    expect(sanitizeFtsQuery("café résumé")).toBe("café résumé");
  });
});
