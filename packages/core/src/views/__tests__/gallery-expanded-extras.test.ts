import { describe, it, expect } from "vitest";
import type { BasesEntry } from "obsidian";
import {
  parseCategoryTags,
  buildCategoryTagChips,
} from "@/views/gallery-expanded-extras";

/** Minimal BasesEntry stub that stores note.tags as a comma-separated string
 *  (matching the frontmatterBasesEntry encoding). */
function mkEntry(tags: string[]): BasesEntry {
  const tagsStr = tags.join(", ");
  return {
    file: { path: "Bookmarks/TikTok/test.md", basename: "test" },
    getValue: (key: string) => (key === "note.tags" ? tagsStr : null),
  } as unknown as BasesEntry;
}

describe("parseCategoryTags", () => {
  it("returns empty array when no tags", () => {
    const entry = mkEntry([]);
    expect(parseCategoryTags(entry)).toEqual([]);
  });

  it("returns empty array when no category/ tags", () => {
    const entry = mkEntry(["tiktok", "collection/Fitness", "food"]);
    expect(parseCategoryTags(entry)).toEqual([]);
  });

  it("strips category/ prefix and un-slugs single tag", () => {
    const entry = mkEntry(["category/tech"]);
    expect(parseCategoryTags(entry)).toEqual(["Tech"]);
  });

  it("handles multiple category tags alongside other tags", () => {
    const entry = mkEntry([
      "tiktok",
      "collection/Fitness",
      "category/fitness",
      "category/growth",
    ]);
    expect(parseCategoryTags(entry)).toEqual(["Fitness", "Growth"]);
  });

  it("title-cases multi-word dash-separated slugs", () => {
    // e.g. "places-travel" → "Places Travel"
    const entry = mkEntry(["category/places-travel"]);
    expect(parseCategoryTags(entry)).toEqual(["Places Travel"]);
  });

  it("handles space-preserved slugs (sanitizeFilename keeps spaces)", () => {
    // e.g. "Places & Travel" stored as-is by sanitizeFilename
    const entry = mkEntry(["category/Places & Travel"]);
    expect(parseCategoryTags(entry)).toEqual(["Places & Travel"]);
  });

  it("handles nested category tags (category/tech/ai)", () => {
    const entry = mkEntry(["category/tech/ai"]);
    // un-slug strips prefix → "tech/ai", replace dashes only
    const result = parseCategoryTags(entry);
    expect(result).toEqual(["Tech/Ai"]);
  });
});

describe("buildCategoryTagChips", () => {
  it("returns null when no category tags", () => {
    const entry = mkEntry(["tiktok", "collection/Fitness"]);
    expect(buildCategoryTagChips(entry)).toBeNull();
  });

  it("returns a div with chip spans for each category tag", () => {
    const entry = mkEntry(["category/tech", "category/growth"]);
    const el = buildCategoryTagChips(entry);
    expect(el).not.toBeNull();
    expect(el!.className).toBe("roost-expanded-category-chips");
    const chips = Array.from(el!.querySelectorAll(".roost-expanded-category-chip"));
    expect(chips).toHaveLength(2);
    expect(chips[0].textContent).toBe("Tech");
    expect(chips[1].textContent).toBe("Growth");
  });

  it("chip has a title attribute for hover tooltip", () => {
    const entry = mkEntry(["category/humor"]);
    const el = buildCategoryTagChips(entry)!;
    const chip = el.querySelector(".roost-expanded-category-chip") as HTMLElement;
    expect(chip.getAttribute("title")).toBe("Category: Humor");
  });
});
