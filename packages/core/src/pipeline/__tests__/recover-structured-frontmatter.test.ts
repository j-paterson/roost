// @vitest-environment node
/**
 * Tests for recover-structured-frontmatter.ts
 *
 * Covers:
 *  1. recipe_ingredients recovery from old-shape objects ([object Object]) — writes corrected string[]
 *  2. cache entries whose ingredients are ALREADY strings — passed through as-is
 *  3. note already holding correct strings — no write (no-op)
 *  4. workout_exercises analog
 *  5. Returns correct recipesFixed / workoutsFixed counts
 *
 * Mock strategy:
 *  - Uses a real temp directory for the .roost/cache JSON files (so
 *    loadPipelineCache / fs.writeFileSync work normally).
 *  - Mocks vault.getMarkdownFiles / metadataCache.getFileCache / vault.read /
 *    vault.modify as lightweight in-memory stubs (no disk notes needed).
 *  - Spies on vault.modify to assert write behaviour.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileSystemAdapter, TFile, type App } from "obsidian";
import { recoverStructuredFrontmatter } from "@/pipeline/recover-structured-frontmatter";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeCacheDir(base: string): string {
  const dir = path.join(base, ".roost", "cache");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeCache(dir: string, name: string, data: unknown): void {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
}

interface NoteSpec {
  roostId: string;
  path: string;
  frontmatter: Record<string, unknown>;
  /** Raw content of the file (a minimal FM block). Will be read by vault.read. */
  content: string;
}

/**
 * Build a minimal plugin mock backed by an in-memory note set and a real temp
 * vault directory (so loadPipelineCache can read from disk).
 */
function makePlugin(base: string, notes: NoteSpec[]) {
  const adapter = new FileSystemAdapter();
  adapter.basePath = base;

  const modifySpy = vi.fn().mockResolvedValue(undefined);
  const readSpy = vi.fn(async (file: TFile) => {
    const n = notes.find(n => n.path === (file as any).path);
    return n?.content ?? "";
  });

  const vault = {
    adapter,
    getMarkdownFiles: () => notes.map(n => Object.assign(new TFile(), { path: n.path })),
    read: readSpy,
    modify: modifySpy,
  };

  const metadataCache = {
    getFileCache: (file: TFile) => {
      const n = notes.find(n => n.path === (file as any).path);
      return n ? { frontmatter: n.frontmatter } : null;
    },
  };

  const app = { vault, metadataCache } as unknown as App;

  const plugin = {
    app,
    settings: { syncFolder: "Bookmarks" },
  } as any;

  return { plugin, modifySpy };
}

/** Build a minimal YAML frontmatter note string. */
function noteContent(roostId: string, extraYaml = ""): string {
  return `---\nroost_id: ${roostId}\n${extraYaml}---\n\nbody\n`;
}

// ── fixtures ──────────────────────────────────────────────────────────────────

/** Cache entry whose `ingredients` uses the OLD object shape. */
const OLD_INGREDIENT_CACHE = {
  "tiktok:recipe1": {
    triage: "recipe",
    extraction: {
      dish: "Butter Toast",
      cuisine: "American",
      // Old shape — objects, as they were stored before the fix
      ingredients: [
        { item: "Bread", qty: null },
        { item: "Butter", qty: "2 tbsp" },
      ],
      steps: ["Toast bread", "Spread butter"],
      prepTime: null,
      cookTime: "2m",
      difficulty: "medium",
      notes: null,
      recipeLink: null,
    },
  },
};

/** Cache entry whose `ingredients` are ALREADY strings (new shape). */
const ALREADY_STRING_INGREDIENT_CACHE = {
  "tiktok:recipe2": {
    triage: "recipe",
    extraction: {
      dish: "Pasta",
      cuisine: "Italian",
      ingredients: ["200g pasta", "100g guanciale"],
      steps: ["Boil pasta"],
      prepTime: null,
      cookTime: "15m",
      difficulty: "medium",
      notes: null,
      recipeLink: null,
    },
  },
};

/** Cache entry whose `exercises` use the OLD object shape. */
const OLD_EXERCISE_CACHE = {
  "tiktok:workout1": {
    triage: "workout",
    extraction: {
      workoutType: "strength",
      name: "Leg Day",
      targetArea: "legs",
      // Old shape — objects
      exercises: [
        { name: "Squat", reps: "3x10" },
        { name: "Lunge", reps: null },
      ],
      duration: "30 min",
      difficulty: "intermediate",
      equipment: ["dumbbells"],
      notes: null,
    },
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("recoverStructuredFrontmatter — recipe_ingredients", () => {
  let tmp: string;
  let cacheDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roost-recover-"));
    cacheDir = makeCacheDir(tmp);
    // Seed empty workouts cache so workouts path doesn't fail
    writeCache(cacheDir, "workouts-cache.json", {});
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("recovers recipe_ingredients from old object shape ([object Object]) and writes corrected string[]", async () => {
    writeCache(cacheDir, "recipe-cache.json", OLD_INGREDIENT_CACHE);

    // The note currently has corrupt "[object Object]" frontmatter
    const note: NoteSpec = {
      roostId: "tiktok:recipe1",
      path: "Bookmarks/tiktok-recipe1/tiktok-recipe1.md",
      frontmatter: {
        roost_id: "tiktok:recipe1",
        recipe_ingredients: ["[object Object]"],  // corrupt
      },
      content: noteContent(
        "tiktok:recipe1",
        "recipe_ingredients:\n  - \"[object Object]\"\n",
      ),
    };

    const { plugin, modifySpy } = makePlugin(tmp, [note]);
    const result = await recoverStructuredFrontmatter(plugin);

    // Should have written the file
    expect(modifySpy).toHaveBeenCalledOnce();
    const writtenContent: string = modifySpy.mock.calls[0][1];
    expect(writtenContent).toContain("Bread");
    expect(writtenContent).toContain("2 tbsp Butter");
    expect(writtenContent).not.toContain("[object Object]");

    expect(result.recipesFixed).toBe(1);
    expect(result.workoutsFixed).toBe(0);
  });

  it("passes through ingredients that are ALREADY strings without modification", async () => {
    writeCache(cacheDir, "recipe-cache.json", ALREADY_STRING_INGREDIENT_CACHE);

    // The note has correct string[] frontmatter
    const note: NoteSpec = {
      roostId: "tiktok:recipe2",
      path: "Bookmarks/tiktok-recipe2/tiktok-recipe2.md",
      frontmatter: {
        roost_id: "tiktok:recipe2",
        recipe_ingredients: ["200g pasta", "100g guanciale"],
      },
      content: noteContent(
        "tiktok:recipe2",
        "recipe_ingredients:\n  - 200g pasta\n  - 100g guanciale\n",
      ),
    };

    const { plugin, modifySpy } = makePlugin(tmp, [note]);
    const result = await recoverStructuredFrontmatter(plugin);

    // Content is already correct — no write needed
    expect(modifySpy).not.toHaveBeenCalled();
    expect(result.recipesFixed).toBe(0);
  });

  it("does NOT rewrite a note that already holds the correct strings", async () => {
    // Cache has old objects, but frontmatter has already been fixed
    writeCache(cacheDir, "recipe-cache.json", OLD_INGREDIENT_CACHE);

    const note: NoteSpec = {
      roostId: "tiktok:recipe1",
      path: "Bookmarks/tiktok-recipe1/tiktok-recipe1.md",
      frontmatter: {
        roost_id: "tiktok:recipe1",
        // Already fixed — matches what we'd recover
        recipe_ingredients: ["Bread", "2 tbsp Butter"],
      },
      content: noteContent(
        "tiktok:recipe1",
        "recipe_ingredients:\n  - Bread\n  - 2 tbsp Butter\n",
      ),
    };

    const { plugin, modifySpy } = makePlugin(tmp, [note]);
    const result = await recoverStructuredFrontmatter(plugin);

    expect(modifySpy).not.toHaveBeenCalled();
    expect(result.recipesFixed).toBe(0);
  });
});

describe("recoverStructuredFrontmatter — workout_exercises", () => {
  let tmp: string;
  let cacheDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roost-recover-"));
    cacheDir = makeCacheDir(tmp);
    // Seed empty recipe cache
    writeCache(cacheDir, "recipe-cache.json", {});
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("recovers workout_exercises from old object shape and writes corrected string[]", async () => {
    writeCache(cacheDir, "workouts-cache.json", OLD_EXERCISE_CACHE);

    const note: NoteSpec = {
      roostId: "tiktok:workout1",
      path: "Bookmarks/tiktok-workout1/tiktok-workout1.md",
      frontmatter: {
        roost_id: "tiktok:workout1",
        workout_exercises: ["[object Object]"],  // corrupt
      },
      content: noteContent(
        "tiktok:workout1",
        "workout_exercises:\n  - \"[object Object]\"\n",
      ),
    };

    const { plugin, modifySpy } = makePlugin(tmp, [note]);
    const result = await recoverStructuredFrontmatter(plugin);

    expect(modifySpy).toHaveBeenCalledOnce();
    const writtenContent: string = modifySpy.mock.calls[0][1];
    // Squat with reps
    expect(writtenContent).toContain("Squat — 3x10");
    // Lunge without reps (no null appended)
    expect(writtenContent).toContain("Lunge");
    expect(writtenContent).not.toContain("[object Object]");

    expect(result.recipesFixed).toBe(0);
    expect(result.workoutsFixed).toBe(1);
  });
});

describe("recoverStructuredFrontmatter — counts", () => {
  let tmp: string;
  let cacheDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roost-recover-"));
    cacheDir = makeCacheDir(tmp);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns recipesFixed=1 workoutsFixed=1 when one of each is recovered", async () => {
    writeCache(cacheDir, "recipe-cache.json", OLD_INGREDIENT_CACHE);
    writeCache(cacheDir, "workouts-cache.json", OLD_EXERCISE_CACHE);

    const notes: NoteSpec[] = [
      {
        roostId: "tiktok:recipe1",
        path: "Bookmarks/tiktok-recipe1/tiktok-recipe1.md",
        frontmatter: {
          roost_id: "tiktok:recipe1",
          recipe_ingredients: ["[object Object]"],
        },
        content: noteContent("tiktok:recipe1", "recipe_ingredients:\n  - \"[object Object]\"\n"),
      },
      {
        roostId: "tiktok:workout1",
        path: "Bookmarks/tiktok-workout1/tiktok-workout1.md",
        frontmatter: {
          roost_id: "tiktok:workout1",
          workout_exercises: ["[object Object]"],
        },
        content: noteContent("tiktok:workout1", "workout_exercises:\n  - \"[object Object]\"\n"),
      },
    ];

    const { plugin } = makePlugin(tmp, notes);
    const result = await recoverStructuredFrontmatter(plugin);

    expect(result.recipesFixed).toBe(1);
    expect(result.workoutsFixed).toBe(1);
  });

  it("creates a .PRE-RECOVER-BACKUP.json for the recipe cache", async () => {
    writeCache(cacheDir, "recipe-cache.json", OLD_INGREDIENT_CACHE);
    writeCache(cacheDir, "workouts-cache.json", {});

    const note: NoteSpec = {
      roostId: "tiktok:recipe1",
      path: "Bookmarks/tiktok-recipe1/tiktok-recipe1.md",
      frontmatter: { roost_id: "tiktok:recipe1", recipe_ingredients: ["[object Object]"] },
      content: noteContent("tiktok:recipe1", "recipe_ingredients:\n  - \"[object Object]\"\n"),
    };

    const { plugin } = makePlugin(tmp, [note]);
    await recoverStructuredFrontmatter(plugin);

    const backupPath = path.join(cacheDir, "recipe-cache.PRE-RECOVER-BACKUP.json");
    expect(fs.existsSync(backupPath)).toBe(true);
    const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"));
    expect(backup).toHaveProperty("tiktok:recipe1");
  });
});
