/**
 * Tests for lib/category-tags.ts — shared slug + tag-write helpers.
 *
 * Parity contract (the binding faithfulness invariant from the Wave-2 D1 spec):
 *   The TS slug logic (categorySlug / tagToObsidianTag) must produce IDENTICAL
 *   output to the JS tagSlug / tagToObsidianTag functions in
 *   scripts/migrate-to-tags.mjs for any category name.
 *
 * The fixture below also exercises the full pipeline:
 *   classifyTags (fixed vec + small detector) → fired tags → tagToObsidianTag
 * and asserts that the resulting category/* strings are byte-for-byte what
 * migrate-to-tags.mjs would write.
 */

import { describe, it, expect } from "vitest";
import { categorySlug, tagToObsidianTag, appendCategoryTags } from "@/lib/category-tags";
import { classifyTags, type TagDetectors } from "@/pipeline/tag-detectors";

// ── categorySlug — exact parity with migrate-to-tags.mjs tagSlug ─────────────

describe("categorySlug — parity with migrate-to-tags.mjs tagSlug", () => {
  it("lowercase + alphanumerics pass through", () => {
    expect(categorySlug("tech")).toBe("tech");
  });

  it("uppercases are lowercased", () => {
    expect(categorySlug("Tech")).toBe("tech");
  });

  it("spaces → dash", () => {
    expect(categorySlug("Content Creation")).toBe("content-creation");
  });

  it("ampersand + spaces → single dash (run of non-alnum collapsed)", () => {
    // "Places & Travel" → spaces + & are all non-alphanumeric → single run → "-"
    expect(categorySlug("Places & Travel")).toBe("places-travel");
  });

  it("leading / trailing non-alnum are trimmed", () => {
    expect(categorySlug("  tech  ")).toBe("tech");
    expect(categorySlug("-tech-")).toBe("tech");
  });

  it("empty string → 'untitled'", () => {
    expect(categorySlug("")).toBe("untitled");
  });

  it("already-valid slug is unchanged", () => {
    expect(categorySlug("food-drink")).toBe("food-drink");
  });

  it("multiple internal non-alnum runs collapse to single dash", () => {
    expect(categorySlug("Art & Design -- Illustration")).toBe("art-design-illustration");
  });

  it("numbers are preserved", () => {
    expect(categorySlug("Top 10")).toBe("top-10");
  });
});

// ── tagToObsidianTag — parity with migrate-to-tags.mjs tagToObsidianTag ──────

describe("tagToObsidianTag — parity with migrate-to-tags.mjs tagToObsidianTag", () => {
  it("flat tag: 'Tech' → 'category/tech'", () => {
    expect(tagToObsidianTag("Tech")).toBe("category/tech");
  });

  it("flat tag with spaces: 'Places & Travel' → 'category/places-travel'", () => {
    expect(tagToObsidianTag("Places & Travel")).toBe("category/places-travel");
  });

  it("flat tag: 'Content Creation' → 'category/content-creation'", () => {
    expect(tagToObsidianTag("Content Creation")).toBe("category/content-creation");
  });

  it("flat tag: 'Humor' → 'category/humor'", () => {
    expect(tagToObsidianTag("Humor")).toBe("category/humor");
  });

  it("nested 'Parent/Child' → 'category/parent/child'", () => {
    expect(tagToObsidianTag("Parent/Child")).toBe("category/parent/child");
  });

  it("nested with spaces: 'Places & Travel/City Breaks' → 'category/places-travel/city-breaks'", () => {
    expect(tagToObsidianTag("Places & Travel/City Breaks")).toBe("category/places-travel/city-breaks");
  });

  it("single word: 'Art' → 'category/art'", () => {
    expect(tagToObsidianTag("Art")).toBe("category/art");
  });
});

// ── appendCategoryTags ─────────────────────────────────────────────────────────

describe("appendCategoryTags", () => {
  it("appends new category tags to an empty array", () => {
    const result = appendCategoryTags([], ["Tech", "Humor"]);
    expect(result).toEqual(["category/tech", "category/humor"]);
  });

  it("preserves existing tags and appends only new ones", () => {
    const existing = ["tiktok", "collection/saved", "category/tech"];
    const result = appendCategoryTags(existing, ["Tech", "Humor"]);
    expect(result).toEqual(["tiktok", "collection/saved", "category/tech", "category/humor"]);
  });

  it("does not duplicate a tag already present", () => {
    const existing = ["category/tech"];
    const result = appendCategoryTags(existing, ["Tech"]);
    expect(result).toEqual(["category/tech"]);
  });

  it("does not duplicate within the names list itself", () => {
    const result = appendCategoryTags([], ["Tech", "Tech"]);
    expect(result).toEqual(["category/tech"]);
  });

  it("empty names list returns existing tags unchanged", () => {
    const existing = ["tiktok"];
    const result = appendCategoryTags(existing, []);
    expect(result).toEqual(["tiktok"]);
  });

  it("handles nested category names", () => {
    const result = appendCategoryTags([], ["Places & Travel/City Breaks"]);
    expect(result).toEqual(["category/places-travel/city-breaks"]);
  });
});

// ── Parity test: classifyTags → category/* slugs match migrate-to-tags.mjs ───
//
// This is the D1 "faithfulness invariant" test from the spec.
//
// Fixture: 3-tag detector, 4-dimensional embedding.
// Hand-computed expected firing set and primary (same fixture as tag-detectors.test.ts).
//
//   x = [3, 4, 0, 0]  ||x||=5  x_norm=[0.6, 0.8, 0, 0]
//   W: Art=[1,0,0,0], Tech=[0,1,0,0], Humor=[0,0,1,0]
//   b = [0.5, -0.5, -5.0]
//   thresholds = [0.7, 0.6, 0.1]
//
//   s_Art=0.750, s_Tech=0.574, s_Humor=0.007
//   Art fires (0.750>=0.7), Tech does NOT (0.574<0.6), Humor does NOT
//   primary = Art (argmax)
//   fired set = ["Art"]
//
// Expected category/* tags (matching migrate-to-tags.mjs tagToObsidianTag):
//   "Art"   → "category/art"
//   primary → "category/art"
//
// With Tech threshold lowered to 0.5, both Art and Tech fire:
//   fired = ["Art", "Tech"]
//   category/* = ["category/art", "category/tech"]

const FIXTURE_DET: TagDetectors = {
  tags: ["Art", "Tech", "Humor"],
  W: [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
  ],
  b: [0.5, -0.5, -5.0],
  thresholds: [0.7, 0.6, 0.1],
  dim: 4,
};

const FIXTURE_VEC = [3, 4, 0, 0];

describe("D1 parity: classifyTags → category/* slugs match migrate-to-tags.mjs", () => {
  it("single firing tag (Art): category/* = ['category/art']", () => {
    const { tags, primary } = classifyTags(FIXTURE_VEC, FIXTURE_DET);

    // Exactly one tag fires
    expect(tags).toEqual(["Art"]);
    expect(primary).toBe("Art");

    // Map fired tags to Obsidian category/* strings (same as migrate-to-tags.mjs)
    const obsidianTags = tags.map(tagToObsidianTag);
    expect(obsidianTags).toEqual(["category/art"]);

    // Primary tag also maps correctly
    expect(tagToObsidianTag(primary!)).toBe("category/art");
  });

  it("two firing tags (Art + Tech): category/* = ['category/art', 'category/tech']", () => {
    const det: TagDetectors = { ...FIXTURE_DET, thresholds: [0.7, 0.5, 0.1] };
    const { tags, primary } = classifyTags(FIXTURE_VEC, det);

    expect(tags).toContain("Art");
    expect(tags).toContain("Tech");
    expect(tags).not.toContain("Humor");
    expect(primary).toBe("Art");

    const obsidianTags = tags.map(tagToObsidianTag);
    // appendCategoryTags on an empty existing set should give these exact two
    const appended = appendCategoryTags([], tags);
    expect(appended).toEqual(["category/art", "category/tech"]);
    expect(obsidianTags).toEqual(["category/art", "category/tech"]);
  });

  it("real-world names: 'Places & Travel' → 'category/places-travel' (matches mjs)", () => {
    // Simulate a detector that fires "Places & Travel"
    const det: TagDetectors = {
      tags: ["Places & Travel", "Food & Drink"],
      W: [[1, 0, 0, 0], [0, 1, 0, 0]],
      b: [0.5, -5.0],
      thresholds: [0.6, 0.6],
      dim: 4,
    };
    // x=[3,4,0,0]: s_Travel=sigmoid(0.6+0.5)=0.750, s_Food=sigmoid(0.8-5)=0.0055
    const { tags, primary } = classifyTags([3, 4, 0, 0], det);
    expect(tags).toEqual(["Places & Travel"]);
    expect(primary).toBe("Places & Travel");

    // The key parity assertion: the Obsidian tag string must match what
    // migrate-to-tags.mjs tagToObsidianTag("Places & Travel") produces.
    // mjs: .toLowerCase() → "places & travel" → /[^a-z0-9]+/g → "-" → "places-travel"
    // → "category/places-travel"
    const obsTag = tagToObsidianTag(primary!);
    expect(obsTag).toBe("category/places-travel");
  });

  it("appendCategoryTags never removes existing tags (migrate-to-tags.mjs invariant)", () => {
    const { tags } = classifyTags(FIXTURE_VEC, FIXTURE_DET);
    const existing = ["tiktok", "collection/saved", "category/art"];
    const result = appendCategoryTags(existing, tags);
    // All original tags still present
    for (const t of existing) {
      expect(result).toContain(t);
    }
    // No category/art duplicate added
    expect(result.filter(t => t === "category/art")).toHaveLength(1);
  });
});
