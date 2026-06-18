import { describe, it, expect } from "vitest";
import { resortPatch, resortByCollection } from "../resort-by-collection";
import type { CollectionAliasMap } from "@/lib/collection-aliases";
import type { App } from "obsidian";

// ── stubApp mirrors folder-backfill.test.ts ────────────────────────────────
/** fs-free App stub: processFrontMatter mutates the same fm object getFileCache returns. */
function stubApp(files: { path: string; fm: Record<string, unknown> }[]): App {
  const byPath = new Map(files.map((f) => [f.path, f.fm]));
  return {
    vault: { getMarkdownFiles: () => files.map((f) => ({ path: f.path })) },
    metadataCache: {
      getFileCache: (file: { path: string }) => ({ frontmatter: byPath.get(file.path) }),
    },
    fileManager: {
      processFrontMatter: async (
        file: { path: string },
        fn: (fm: Record<string, unknown>) => void,
      ) => {
        fn(byPath.get(file.path)!);
      },
    },
  } as unknown as App;
}

// ── resortPatch ────────────────────────────────────────────────────────────
describe("resortPatch", () => {
  const aliases: CollectionAliasMap = {
    "tiktok:Finance Tips": "Finances",
    "twitter:Sports": "Athletics",
  };

  it("returns null when collection is missing", () => {
    expect(resortPatch({}, aliases)).toBeNull();
    expect(resortPatch({ collection: "" }, aliases)).toBeNull();
    expect(resortPatch({ collection: "undefined" }, aliases)).toBeNull();
    expect(resortPatch({ collection: "null" }, aliases)).toBeNull();
  });

  it("returns patch with alias when collection has an alias", () => {
    const fm = { platform: "tiktok", collection: "Finance Tips" };
    expect(resortPatch(fm, aliases)).toEqual({
      roost_category: "Finances",
      roost_assigned_by: "human",
    });
  });

  it("returns patch with raw collection when no alias exists", () => {
    const fm = { platform: "tiktok", collection: "Random Finds" };
    expect(resortPatch(fm, aliases)).toEqual({
      roost_category: "Random Finds",
      roost_assigned_by: "human",
    });
  });

  it("returns null when already correctly set by a human", () => {
    const fm = {
      platform: "tiktok",
      collection: "Finance Tips",
      roost_category: "Finances",
      roost_assigned_by: "human",
    };
    expect(resortPatch(fm, aliases)).toBeNull();
  });

  it("returns patch when auto roost_category differs from target (overwrite)", () => {
    const fm = {
      platform: "tiktok",
      collection: "Finance Tips",
      roost_category: "SomeAutoCategory",
      roost_assigned_by: "auto",
    };
    expect(resortPatch(fm, aliases)).toEqual({
      roost_category: "Finances",
      roost_assigned_by: "human",
    });
  });

  it("returns patch when human roost_category differs from resolved target", () => {
    // roost_category is human but doesn't match the alias → still overwrite
    const fm = {
      platform: "tiktok",
      collection: "Finance Tips",
      roost_category: "OldHumanCategory",
      roost_assigned_by: "human",
    };
    expect(resortPatch(fm, aliases)).toEqual({
      roost_category: "Finances",
      roost_assigned_by: "human",
    });
  });

  it("uses empty-string platform (no platform field) for alias lookup", () => {
    // makeAliasKey("", "Finance Tips") → ":Finance Tips" — no alias → falls back to raw
    const fmNoPlatform = { collection: "Finance Tips" };
    const result = resortPatch(fmNoPlatform, aliases);
    expect(result).toEqual({ roost_category: "Finance Tips", roost_assigned_by: "human" });
  });

  it("clears an orphaned subcategory when the category CHANGES", () => {
    // A subcategory is a child of a specific category; moving the note to a new
    // category strands it, so the resort must clear it.
    const fm = {
      platform: "tiktok",
      collection: "Finance Tips",
      roost_category: "OldAuto",
      roost_assigned_by: "auto",
      roost_subcategory: "Web_Development",
    };
    expect(resortPatch(fm, aliases)).toEqual({
      roost_category: "Finances",
      roost_assigned_by: "human",
      roost_subcategory: null,
    });
  });

  it("does NOT touch the subcategory when only provenance flips (category unchanged)", () => {
    // category already equals the target — the subcategory is still valid, keep it.
    const fm = {
      platform: "tiktok",
      collection: "Finance Tips",
      roost_category: "Finances",
      roost_assigned_by: "auto",
      roost_subcategory: "Budgeting",
    };
    expect(resortPatch(fm, aliases)).toEqual({
      roost_category: "Finances",
      roost_assigned_by: "human",
    });
  });

  it("omits the subcategory clear when there is no subcategory to clear", () => {
    const fm = { platform: "tiktok", collection: "Finance Tips", roost_category: "OldAuto", roost_assigned_by: "auto" };
    expect(resortPatch(fm, aliases)).toEqual({ roost_category: "Finances", roost_assigned_by: "human" });
  });
});

// ── resortByCollection ────────────────────────────────────────────────────
describe("resortByCollection", () => {
  const aliases: CollectionAliasMap = {
    "tiktok:Finance Tips": "Finances",
  };

  function makeFiles() {
    return [
      // Will be changed: auto category, has alias
      {
        path: "Bookmarks/a.md",
        fm: { platform: "tiktok", collection: "Finance Tips", roost_category: "OldAuto", roost_assigned_by: "auto" },
      },
      // Already correct: human-assigned, alias matches
      {
        path: "Bookmarks/b.md",
        fm: { platform: "tiktok", collection: "Finance Tips", roost_category: "Finances", roost_assigned_by: "human" },
      },
      // Will be changed: no roost_category, has collection without alias
      {
        path: "Bookmarks/c.md",
        fm: { platform: "tiktok", collection: "Cooking Hacks" },
      },
      // No collection: skipped entirely (not counted in already)
      {
        path: "Bookmarks/d.md",
        fm: { platform: "tiktok" },
      },
      // Outside syncFolder: invisible to getSyncFiles
      {
        path: "OtherFolder/e.md",
        fm: { platform: "tiktok", collection: "Finance Tips" },
      },
    ];
  }

  it("counts changed and already correctly with apply mode", async () => {
    const files = makeFiles();
    const app = stubApp(files);
    const result = await resortByCollection(app, "Bookmarks", aliases, { dryRun: false });
    expect(result.changed).toBe(2);
    expect(result.already).toBe(1);
    expect(result.byTarget).toEqual({ Finances: 1, "Cooking Hacks": 1 });
  });

  it("writes roost_category + roost_assigned_by to changed notes", async () => {
    const files = makeFiles();
    const app = stubApp(files);
    await resortByCollection(app, "Bookmarks", aliases, { dryRun: false });

    // a: was OldAuto, now Finances
    expect(files[0].fm.roost_category).toBe("Finances");
    expect(files[0].fm.roost_assigned_by).toBe("human");

    // c: had no roost_category, now Cooking Hacks
    expect(files[2].fm.roost_category).toBe("Cooking Hacks");
    expect(files[2].fm.roost_assigned_by).toBe("human");
  });

  it("leaves already-correct and no-collection notes untouched", async () => {
    const files = makeFiles();
    const app = stubApp(files);
    await resortByCollection(app, "Bookmarks", aliases, { dryRun: false });

    // b: already correct, should not change
    expect(files[1].fm).toEqual({
      platform: "tiktok",
      collection: "Finance Tips",
      roost_category: "Finances",
      roost_assigned_by: "human",
    });

    // d: no collection, skipped
    expect(files[3].fm).toEqual({ platform: "tiktok" });
  });

  it("dryRun makes NO writes but returns the same changed count", async () => {
    const files = makeFiles();
    const app = stubApp(files);
    const result = await resortByCollection(app, "Bookmarks", aliases, { dryRun: true });

    // Same counts as apply mode
    expect(result.changed).toBe(2);
    expect(result.already).toBe(1);

    // But frontmatter must not have been mutated
    expect(files[0].fm.roost_category).toBe("OldAuto");
    expect(files[0].fm.roost_assigned_by).toBe("auto");
    expect(files[2].fm.roost_category).toBeUndefined();
  });

  it("deletes the orphaned subcategory key from a note whose category changes", async () => {
    const files = [
      { path: "Bookmarks/a.md", fm: { platform: "tiktok", collection: "Finance Tips", roost_category: "OldAuto", roost_assigned_by: "auto", roost_subcategory: "Web_Development" } },
    ];
    const app = stubApp(files);
    await resortByCollection(app, "Bookmarks", aliases, { dryRun: false });
    expect(files[0].fm).toEqual({
      platform: "tiktok",
      collection: "Finance Tips",
      roost_category: "Finances",
      roost_assigned_by: "human",
    });
    expect("roost_subcategory" in files[0].fm).toBe(false);
  });

  it("files outside syncFolder are ignored", async () => {
    const files = makeFiles();
    const app = stubApp(files);
    await resortByCollection(app, "Bookmarks", aliases, { dryRun: false });
    // e.md in OtherFolder is untouched
    expect(files[4].fm.roost_category).toBeUndefined();
  });
});
