import { describe, it, expect } from "vitest";
import type { App, TFile } from "obsidian";
import {
  buildFilterInput,
  buildResortInput,
  buildSubcategorizeInput,
} from "@/ui/lib/smart-assign-inputs";

type Fm = {
  roost_id?: string;
  roost_category?: string;
  roost_subcategory?: string;
  platform?: string;
  roost_assigned_by?: string;
};

function mkApp(files: { path: string; fm: Fm }[]): App {
  const fileObjs = files.map(f => ({ path: f.path } as TFile));
  const fmByPath = new Map(files.map(f => [f.path, f.fm]));
  return {
    vault: {
      getMarkdownFiles: () => fileObjs,
    },
    metadataCache: {
      getFileCache: (f: TFile) => ({ frontmatter: fmByPath.get(f.path) }),
    },
  } as unknown as App;
}

describe("smart-assign-inputs builders (stub)", () => {
  it("module loads", () => {
    expect(buildFilterInput).toBeDefined();
    expect(buildResortInput).toBeDefined();
    expect(buildSubcategorizeInput).toBeDefined();
  });
});

describe("buildResortInput", () => {
  it("returns all items in the category and all vault collections as anchors", () => {
    const app = mkApp([
      { path: "roost/a.md", fm: { roost_id: "a", roost_category: "Animals" } },
      { path: "roost/b.md", fm: { roost_id: "b", roost_category: "Animals", roost_subcategory: "Dogs" } },
      { path: "roost/c.md", fm: { roost_id: "c", roost_category: "Food" } },
      { path: "roost/d.md", fm: { roost_id: "d", roost_category: "Food" } },
    ]);
    const input = buildResortInput(app, "roost", "Animals");
    expect(input.itemIds.sort()).toEqual(["a", "b"]);
    expect(Object.keys(input.collections).sort()).toEqual(["Food"]);
    expect(input.topics.sort()).toEqual(["Animals", "Food"]);
    expect(input.write).toEqual({ into: "category" });
    expect(input.allowDiscovery).toBe(true);
  });

  it("carries provenance from roost_assigned_by", () => {
    const app = mkApp([
      { path: "roost/a.md", fm: { roost_id: "a", roost_category: "Animals", roost_assigned_by: "human" } },
      { path: "roost/b.md", fm: { roost_id: "b", roost_category: "Animals", roost_assigned_by: "auto" } },
    ]);
    const input = buildResortInput(app, "roost", "Animals");
    expect(input.itemProvenance.get("a")).toBe("human");
    expect(input.itemProvenance.get("b")).toBe("auto");
  });
});

describe("buildSubcategorizeInput", () => {
  it("scopes anchors and topics to the parent's existing subcategories", () => {
    const app = mkApp([
      { path: "roost/a.md", fm: { roost_id: "a", roost_category: "Animals", roost_subcategory: "Dogs" } },
      { path: "roost/b.md", fm: { roost_id: "b", roost_category: "Animals", roost_subcategory: "Dogs" } },
      { path: "roost/c.md", fm: { roost_id: "c", roost_category: "Animals", roost_subcategory: "Cats" } },
      { path: "roost/d.md", fm: { roost_id: "d", roost_category: "Animals" } },
      { path: "roost/e.md", fm: { roost_id: "e", roost_category: "Food" } },
    ]);
    const input = buildSubcategorizeInput(app, "roost", "Animals");
    expect(input.itemIds.sort()).toEqual(["a", "b", "c", "d"]);
    expect(Object.keys(input.collections).sort()).toEqual(["Cats", "Dogs"]);
    expect(input.topics.sort()).toEqual(["Cats", "Dogs"]);
    expect(input.write).toEqual({ into: "subcategoryOf", parent: "Animals" });
    expect(input.allowDiscovery).toBe(false);
  });

  it("returns empty anchors when the parent has no subcategories", () => {
    const app = mkApp([
      { path: "roost/a.md", fm: { roost_id: "a", roost_category: "Animals" } },
      { path: "roost/b.md", fm: { roost_id: "b", roost_category: "Animals" } },
    ]);
    const input = buildSubcategorizeInput(app, "roost", "Animals");
    expect(input.itemIds.sort()).toEqual(["a", "b"]);
    expect(input.collections).toEqual({});
    expect(input.topics).toEqual([]);
    expect(input.write).toEqual({ into: "subcategoryOf", parent: "Animals" });
    expect(input.allowDiscovery).toBe(false);
  });

  it("merges emptySubcategories settings into collections + topics with zero items", () => {
    const app = mkApp([
      { path: "Bookmarks/a.md", fm: { roost_id: "a", roost_category: "Media List", roost_subcategory: "Book" } },
      { path: "Bookmarks/b.md", fm: { roost_id: "b", roost_category: "Media List" } },
      { path: "Bookmarks/c.md", fm: { roost_id: "c", roost_category: "Media List", roost_subcategory: "Book" } },
    ]);
    const result = buildSubcategorizeInput(app, "Bookmarks", "Media List", ["Music", "Anime", "Movie"]);
    expect(result.itemIds.sort()).toEqual(["a", "b", "c"]);
    expect(result.collections).toEqual({
      Book: ["a", "c"],
      Music: [],
      Anime: [],
      Movie: [],
    });
    expect(result.topics.sort()).toEqual(["Anime", "Book", "Movie", "Music"]);
    expect(result.write).toEqual({ into: "subcategoryOf", parent: "Media List" });
    expect(result.allowDiscovery).toBe(false);
  });

  it("does not duplicate when emptySubcats overlaps with frontmatter subcats", () => {
    const app = mkApp([
      { path: "Bookmarks/a.md", fm: { roost_id: "a", roost_category: "Media List", roost_subcategory: "Book" } },
    ]);
    const result = buildSubcategorizeInput(app, "Bookmarks", "Media List", ["Book", "Music"]);
    expect(result.collections).toEqual({ Book: ["a"], Music: [] });
    expect(result.topics.sort()).toEqual(["Book", "Music"]);
  });

  it("works when emptySubcats is omitted (backward compatible)", () => {
    const app = mkApp([
      { path: "Bookmarks/a.md", fm: { roost_id: "a", roost_category: "Media List", roost_subcategory: "Book" } },
    ]);
    const result = buildSubcategorizeInput(app, "Bookmarks", "Media List");
    expect(result.collections).toEqual({ Book: ["a"] });
    expect(result.topics).toEqual(["Book"]);
  });

  it("populates suggestedTopics from cache.category aggregated over item ids", () => {
    const app = mkApp([
      { path: "Bookmarks/a.md", fm: { roost_id: "a", roost_category: "Media List" } },
      { path: "Bookmarks/b.md", fm: { roost_id: "b", roost_category: "Media List" } },
      { path: "Bookmarks/c.md", fm: { roost_id: "c", roost_category: "Media List", roost_subcategory: "Book" } },
    ]);
    const result = buildSubcategorizeInput(app, "Bookmarks", "Media List", [], {
      embeddingCache: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        a: { vision: null, summary: null, category: "Music", vec: null } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        b: { vision: null, summary: null, category: "Music", vec: null } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        c: { vision: null, summary: null, category: "Book", vec: null } as any,
      },
      minCount: 1,
    });
    expect(result.suggestedTopics).toEqual([
      { name: "Music", count: 2 },
      // "Book" is excluded because it's already a topic via frontmatter.
    ]);
  });

  it("returns empty suggestedTopics when no items have categories", () => {
    const app = mkApp([
      { path: "Bookmarks/a.md", fm: { roost_id: "a", roost_category: "Media List" } },
    ]);
    const result = buildSubcategorizeInput(app, "Bookmarks", "Media List", [], {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      embeddingCache: { a: { vision: null, summary: null, category: null, vec: null } as any },
      minCount: 1,
    });
    expect(result.suggestedTopics).toEqual([]);
  });
});

describe("buildFilterInput", () => {
  it("returns unsorted items when filter is null-category", () => {
    const app = mkApp([
      { path: "roost/a.md", fm: { roost_id: "a", platform: "tiktok" } },
      { path: "roost/b.md", fm: { roost_id: "b", platform: "tiktok", roost_category: "Food" } },
      { path: "roost/c.md", fm: { roost_id: "c", platform: "x" } },
    ]);
    const input = buildFilterInput(app, "roost", { platform: "tiktok", category: null });
    expect(input.itemIds.sort()).toEqual(["a"]);
    expect(Object.keys(input.collections).sort()).toEqual(["Food"]);
    expect(input.topics.sort()).toEqual(["Food"]);
    expect(input.write).toEqual({ into: "category" });
    expect(input.allowDiscovery).toBe(true);
  });

  it("returns all vault items when filter is null", () => {
    const app = mkApp([
      { path: "roost/a.md", fm: { roost_id: "a" } },
      { path: "roost/b.md", fm: { roost_id: "b", roost_category: "Food" } },
    ]);
    const input = buildFilterInput(app, "roost", null);
    expect(input.itemIds.sort()).toEqual(["a", "b"]);
  });

  it("respects category filter when set", () => {
    const app = mkApp([
      { path: "roost/a.md", fm: { roost_id: "a", roost_category: "Animals" } },
      { path: "roost/b.md", fm: { roost_id: "b", roost_category: "Food" } },
    ]);
    const input = buildFilterInput(app, "roost", { category: "Animals" });
    expect(input.itemIds.sort()).toEqual(["a"]);
  });
});

export { mkApp };
export type { Fm };
