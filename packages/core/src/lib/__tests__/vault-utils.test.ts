import { describe, it, expect } from "vitest";
import { gatherVaultCollections, gatherCategoryAndSubcategories } from "../vault-utils";
import type { CollectionAliasMap } from "../collection-aliases";
import type { App, TFile } from "obsidian";

type Fm = { roost_id?: string; roost_category?: string; roost_subcategory?: string; platform?: string; collection?: string; roost_assigned_by?: string };

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

describe("gatherCategoryAndSubcategories", () => {
  it("returns items in the target category and groups by subcategory", () => {
    const app = mkApp([
      { path: "roost/a.md", fm: { roost_id: "a", roost_category: "Animals", roost_subcategory: "Dogs" } },
      { path: "roost/b.md", fm: { roost_id: "b", roost_category: "Animals", roost_subcategory: "Dogs" } },
      { path: "roost/c.md", fm: { roost_id: "c", roost_category: "Animals", roost_subcategory: "Cats" } },
      { path: "roost/d.md", fm: { roost_id: "d", roost_category: "Animals" } },
      { path: "roost/e.md", fm: { roost_id: "e", roost_category: "Food" } },
    ]);
    const result = gatherCategoryAndSubcategories(app, "roost", "Animals");
    expect(result.itemIds.sort()).toEqual(["a", "b", "c", "d"]);
    expect(result.collections).toEqual({
      Dogs: ["a", "b"],
      Cats: ["c"],
    });
  });

  it("returns empty collections when no subcategories exist", () => {
    const app = mkApp([
      { path: "roost/a.md", fm: { roost_id: "a", roost_category: "Animals" } },
      { path: "roost/b.md", fm: { roost_id: "b", roost_category: "Animals" } },
    ]);
    const result = gatherCategoryAndSubcategories(app, "roost", "Animals");
    expect(result.itemIds.sort()).toEqual(["a", "b"]);
    expect(result.collections).toEqual({});
  });

  it("ignores files outside the sync folder", () => {
    const app = mkApp([
      { path: "roost/a.md", fm: { roost_id: "a", roost_category: "Animals" } },
      { path: "other/b.md", fm: { roost_id: "b", roost_category: "Animals" } },
    ]);
    const result = gatherCategoryAndSubcategories(app, "roost", "Animals");
    expect(result.itemIds).toEqual(["a"]);
  });

  it("ignores files without roost_id", () => {
    const app = mkApp([
      { path: "roost/a.md", fm: { roost_id: "a", roost_category: "Animals" } },
      { path: "roost/b.md", fm: { roost_category: "Animals" } },
    ]);
    const result = gatherCategoryAndSubcategories(app, "roost", "Animals");
    expect(result.itemIds).toEqual(["a"]);
  });

  it("returns empty when category has no items", () => {
    const app = mkApp([
      { path: "roost/a.md", fm: { roost_id: "a", roost_category: "Food" } },
    ]);
    const result = gatherCategoryAndSubcategories(app, "roost", "Animals");
    expect(result.itemIds).toEqual([]);
    expect(result.collections).toEqual({});
  });

  it("falls back to legacy `collection` field when roost_category is missing", () => {
    const app = mkApp([
      { path: "roost/a.md", fm: { roost_id: "a", collection: "Animals" } },
      { path: "roost/b.md", fm: { roost_id: "b", roost_category: "Animals" } },
    ]);
    const result = gatherCategoryAndSubcategories(app, "roost", "Animals");
    expect(result.itemIds.sort()).toEqual(["a", "b"]);
  });

  it("returns human provenance when roost_assigned_by=human, auto otherwise", () => {
    const app = mkApp([
      { path: "roost/a.md", fm: { roost_id: "a", roost_category: "Animals" } },
      { path: "roost/b.md", fm: { roost_id: "b", roost_category: "Animals", roost_assigned_by: "human" } },
      { path: "roost/c.md", fm: { roost_id: "c", roost_category: "Animals", roost_assigned_by: "auto" } },
    ]);
    const result = gatherCategoryAndSubcategories(app, "roost", "Animals");
    expect(result.itemProvenance.get("a")).toBe("auto");
    expect(result.itemProvenance.get("b")).toBe("human");
    expect(result.itemProvenance.get("c")).toBe("auto");
  });
});

describe("gatherVaultCollections with alias map", () => {
  it("resolves collection → local category via alias when roost_category absent", () => {
    const app = mkApp([
      { path: "roost/a.md", fm: { roost_id: "a", platform: "tiktok", collection: "Finance Tips" } },
      { path: "roost/b.md", fm: { roost_id: "b", roost_category: "Finances" } },
    ]);
    const aliases: CollectionAliasMap = { "tiktok:Finance Tips": "Finances" };
    const result = gatherVaultCollections(app, "roost", undefined, aliases);
    expect(result.itemCollections.get("a")).toBe("Finances");
    expect(result.collections["Finances"]).toContain("a");
    expect(result.collections["Finances"]).toContain("b");
    expect(result.collections["Finance Tips"]).toBeUndefined();
  });
  it("falls back to raw collection name when no alias and no roost_category", () => {
    const app = mkApp([
      { path: "roost/a.md", fm: { roost_id: "a", platform: "tiktok", collection: "Recipes" } },
    ]);
    const result = gatherVaultCollections(app, "roost", undefined, {});
    expect(result.itemCollections.get("a")).toBe("Recipes");
  });
});

describe("gatherCategoryAndSubcategories with alias map", () => {
  it("includes alias-resolved items in the target category", () => {
    const app = mkApp([
      { path: "roost/a.md", fm: { roost_id: "a", collection: "Finance Tips" } },
      { path: "roost/b.md", fm: { roost_id: "b", roost_category: "Finances" } },
    ]);
    const aliases: CollectionAliasMap = { "tiktok:Finance Tips": "Finances" };
    const result = gatherCategoryAndSubcategories(app, "roost", "Finances", aliases);
    expect(result.itemIds.sort()).toEqual(["a", "b"]);
  });
});
