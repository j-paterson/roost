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

  it("returns patch with alias when collection has an alias (fold → subcategory = collection)", () => {
    const fm = { platform: "tiktok", collection: "Finance Tips" };
    expect(resortPatch(fm, aliases)).toEqual({
      roost_category: "Finances",
      roost_assigned_by: "human",
      roost_subcategory: "Finance Tips",
    });
  });

  it("returns patch with raw collection when no alias exists", () => {
    const fm = { platform: "tiktok", collection: "Random Finds" };
    expect(resortPatch(fm, aliases)).toEqual({
      roost_category: "Random Finds",
      roost_assigned_by: "human",
    });
  });

  it("returns null when already correctly set by a human (incl. the folded subcategory)", () => {
    const fm = {
      platform: "tiktok",
      collection: "Finance Tips",
      roost_category: "Finances",
      roost_assigned_by: "human",
      roost_subcategory: "Finance Tips",
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
      roost_subcategory: "Finance Tips",
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
      roost_subcategory: "Finance Tips",
    });
  });

  it("uses empty-string platform (no platform field) for alias lookup", () => {
    // makeAliasKey("", "Finance Tips") → ":Finance Tips" — no alias → falls back to raw
    const fmNoPlatform = { collection: "Finance Tips" };
    const result = resortPatch(fmNoPlatform, aliases);
    expect(result).toEqual({ roost_category: "Finance Tips", roost_assigned_by: "human" });
  });

  it("FOLD: sets subcategory = collection when it folds into a different top-level", () => {
    const aliases2 = { "twitter:web3": "Tech" };
    const fm = { platform: "twitter", collection: "web3", roost_category: "web3", roost_assigned_by: "auto" };
    expect(resortPatch(fm, aliases2)).toEqual({
      roost_category: "Tech",
      roost_assigned_by: "human",
      roost_subcategory: "web3",
    });
  });

  it("FOLD: overwrites a stale subcategory with the folded collection name", () => {
    const aliases2 = { "twitter:web3": "Tech" };
    const fm = { platform: "twitter", collection: "web3", roost_category: "web3", roost_assigned_by: "auto", roost_subcategory: "Web_Development" };
    expect(resortPatch(fm, aliases2)).toMatchObject({ roost_category: "Tech", roost_subcategory: "web3" });
  });

  it("IDENTITY + category moved: clears the orphaned subcategory", () => {
    // collection 'Food' has no alias → target 'Food'; the note was under a different (auto) category.
    const fm = { platform: "tiktok", collection: "Food", roost_category: "OldAuto", roost_assigned_by: "auto", roost_subcategory: "Stale" };
    expect(resortPatch(fm, {})).toEqual({
      roost_category: "Food",
      roost_assigned_by: "human",
      roost_subcategory: null,
    });
  });

  it("IDENTITY + unchanged: leaves a pipeline subcategory untouched", () => {
    // collection 'Food' → 'Food'; category already Food → keep Food/Recipes (pipeline owns it).
    const fm = { platform: "tiktok", collection: "Food", roost_category: "Food", roost_assigned_by: "auto", roost_subcategory: "Recipes" };
    const patch = resortPatch(fm, {});
    expect(patch).toEqual({ roost_category: "Food", roost_assigned_by: "human" });
    expect("roost_subcategory" in patch!).toBe(false);
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
      // Already correct: human-assigned, alias matches, folded subcategory already present
      {
        path: "Bookmarks/b.md",
        fm: { platform: "tiktok", collection: "Finance Tips", roost_category: "Finances", roost_assigned_by: "human", roost_subcategory: "Finance Tips" },
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
      roost_subcategory: "Finance Tips",
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

  it("folds collection→category and rewrites subcategory to the collection name", async () => {
    // 'Finance Tips' folds into 'Finances'; the stale subcategory is replaced by the
    // folded collection name (Finances / Finance Tips), not deleted.
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
      roost_subcategory: "Finance Tips",
    });
  });

  it("files outside syncFolder are ignored", async () => {
    const files = makeFiles();
    const app = stubApp(files);
    await resortByCollection(app, "Bookmarks", aliases, { dryRun: false });
    // e.md in OtherFolder is untouched
    expect(files[4].fm.roost_category).toBeUndefined();
  });
});
