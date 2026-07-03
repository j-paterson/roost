/**
 * TDD: scanLibraryTree must exclude items stamped `roost_belongs_nothing: true`
 * from every count — unsorted, grand total, and category tallies.
 *
 * Task 3 of the belongs-to-nothing feature (feat/belongs-to-nothing branch).
 */
import { describe, it, expect } from "vitest";
import type { App, TFile } from "obsidian";
import { scanLibraryTree } from "@/ui/lib/library-tree";

type Fm = {
  roost_id?: string;
  roost_category?: string;
  roost_subcategory?: string;
  platform?: string;
  roost_belongs_nothing?: boolean;
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

const settings = {
  categoryOrder: [] as string[],
  subcategoryOrder: {} as Record<string, string[]>,
  emptySubcategories: {} as Record<string, string[]>,
};

describe("scanLibraryTree — belongs-nothing exclusion", () => {
  it("excludes a belongs-nothing item from the unsorted count", () => {
    const app = mkApp([
      { path: "Bookmarks/a.md", fm: { roost_id: "a", roost_belongs_nothing: true } },
    ]);
    const result = scanLibraryTree(app, "Bookmarks", settings);
    expect(result.unsorted).toBe(0);
  });

  it("excludes belongs-nothing items from the grand total", () => {
    const app = mkApp([
      { path: "Bookmarks/a.md", fm: { roost_id: "a", roost_belongs_nothing: true } },
      { path: "Bookmarks/b.md", fm: { roost_id: "b", roost_category: "Food" } },
    ]);
    const result = scanLibraryTree(app, "Bookmarks", settings);
    // "b" has a category, so total=1 and unsorted=0
    expect(result.total).toBe(1);
    expect(result.unsorted).toBe(0);
  });

  it("does NOT exclude a normal no-category item (sanity check: it stays unsorted)", () => {
    const app = mkApp([
      { path: "Bookmarks/a.md", fm: { roost_id: "a" } },
    ]);
    const result = scanLibraryTree(app, "Bookmarks", settings);
    expect(result.unsorted).toBe(1);
    expect(result.total).toBe(1);
  });

  it("does NOT exclude an item where roost_belongs_nothing is false", () => {
    const app = mkApp([
      { path: "Bookmarks/a.md", fm: { roost_id: "a", roost_belongs_nothing: false } },
    ]);
    const result = scanLibraryTree(app, "Bookmarks", settings);
    expect(result.unsorted).toBe(1);
  });
});
