/**
 * Plan 032 — recover recipes the extractor misses.
 *
 * Three behaviours:
 *  1. gather-by-filing: a note the user filed under `roost_subcategory: Recipes`
 *     enters `gatherCandidates` even when its embedding category is unrelated
 *     (e.g. "comedy") and it has no recipe tag.
 *  2. caption fast-path: `hasCaptionRecipe` detects a recipe already present in
 *     the caption/description (explicit ingredients+steps, or ≥4 measurement
 *     lines) and rejects a bare hook caption.
 *  3. narrative + repair + empty→null: `extractRecipe` retries once on an empty
 *     result, returns the recipe when either attempt succeeds, and returns
 *     `null` when both attempts are empty (so the runner leaves it to retry).
 *
 * Mocking mirrors `recipe-pipeline-integration.test.ts` (real temp vault +
 * `FileSystemAdapter`) and `ollama-generate.test.ts` (`__setRequestUrlImpl`
 * stub for `ollamaGenerate`).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  gatherCandidates,
  hasCaptionRecipe,
  extractRecipe,
  type RecipeCandidate,
} from "@/pipeline/recipe-pipeline";
import { __resetEmbeddingCache } from "@/pipeline/shared";
import {
  __setRequestUrlImpl,
  __resetRequestUrlImpl,
  App,
  TFile,
  FileSystemAdapter,
} from "obsidian";

// ── gather-by-filing fixture ──────────────────────────────────────────────

/**
 * Build an App backed by a real temp vault holding a single bookmark whose
 * frontmatter is supplied by the caller and whose embedding-cache category is
 * `embedCategory`. Mirrors the integration test's setup so `buildFileIndex`,
 * `loadEmbeddingCache`, and `readRawJson` all read from disk.
 */
function makeAppWith(
  base: string,
  roostId: string,
  fmLines: string,
  embedCategory: string,
): App {
  const syncFolder = "Bookmarks";
  const attachDir = path.join(base, syncFolder, "X", "twitter-rec1");
  fs.mkdirSync(attachDir, { recursive: true });
  fs.writeFileSync(
    path.join(attachDir, "raw.json"),
    JSON.stringify({ text: "some caption", author: { signature: "" } }),
  );

  const noteContent = `---\nroost_id: ${roostId}\n${fmLines}\n---\n\nbody\n`;
  fs.writeFileSync(path.join(attachDir, "twitter-rec1.md"), noteContent);

  const roostDir = path.join(base, ".roost", "cache");
  fs.mkdirSync(roostDir, { recursive: true });
  const txt: Record<string, unknown> = {};
  txt[roostId] = { vision: "people laughing", summary: "", category: embedCategory, vec: null };
  fs.writeFileSync(path.join(roostDir, "embedding-cache.json"), JSON.stringify(txt));

  // loadEmbeddingCache only reads the JSON when the vectors .bin has ≥1 entry.
  const allKeys = [roostId];
  const VEC_DIM = 768;
  const header = Buffer.from(JSON.stringify(allKeys) + "\n", "utf8");
  const floatBuf = Buffer.alloc(allKeys.length * VEC_DIM * 4, 0);
  fs.writeFileSync(
    path.join(roostDir, "embedding-vectors.bin"),
    Buffer.concat([header, floatBuf]),
  );

  const adapter = new FileSystemAdapter();
  adapter.basePath = base;

  const files = new Map<string, string>();
  const relPath = `${syncFolder}/X/twitter-rec1/twitter-rec1.md`;
  files.set(relPath, noteContent);

  const vault = {
    adapter,
    getMarkdownFiles: () =>
      Array.from(files.keys())
        .filter(p => p.endsWith(".md"))
        .map(p => Object.assign(new TFile(), { path: p })),
  };

  const app = new App() as any;
  app.vault = vault;
  app.metadataCache = {
    getFileCache: (f: any) => {
      const content = files.get(f.path) ?? "";
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) return null;
      const fm: Record<string, any> = {};
      for (const line of fmMatch[1].split("\n")) {
        const m = line.match(/^(\w[\w_]*):\s*(.+)$/);
        if (m) fm[m[1]] = m[2].replace(/^"|"$/g, "");
      }
      return { frontmatter: fm };
    },
    getFirstLinkpathDest: () => null,
  };
  return app;
}

describe("gatherCandidates — gather by user filing", () => {
  let tmp: string;

  beforeEach(() => {
    __resetEmbeddingCache();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roost-rrec-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    __resetEmbeddingCache();
  });

  it("admits a note filed under roost_subcategory: Recipes despite an unrelated embedding category and no recipe tags", () => {
    const app = makeAppWith(
      tmp,
      "twitter:rec1",
      'title: "Some funny clip"\nroost_subcategory: Recipes',
      "comedy",
    );
    const candidates = gatherCandidates(app, "Bookmarks");
    expect(candidates).toHaveLength(1);
    expect(candidates[0].roostId).toBe("twitter:rec1");
  });

  it("drops a note that matches neither category, tags, nor user filing", () => {
    const app = makeAppWith(
      tmp,
      "twitter:rec1",
      'title: "Some funny clip"\nroost_subcategory: Comedy',
      "comedy",
    );
    const candidates = gatherCandidates(app, "Bookmarks");
    expect(candidates).toHaveLength(0);
  });
});

// ── caption fast-path ─────────────────────────────────────────────────────

function candidate(partial: Partial<RecipeCandidate>): RecipeCandidate {
  return {
    roostId: "x:1",
    file: new TFile() as TFile,
    title: "",
    subtitle: "",
    description: "",
    vision: "",
    tags: [],
    author: "",
    authorHandle: "",
    url: "",
    recipeLink: null,
    ...partial,
  };
}

describe("hasCaptionRecipe — caption fast-path", () => {
  it("returns true for an explicit Ingredients + Steps caption", () => {
    const c = candidate({
      description: "Marry Me Chicken\n\nIngredients:\nchicken\ncream\n\nSteps:\nsear\nsimmer",
    });
    expect(hasCaptionRecipe(c)).toBe(true);
  });

  it("returns true for a caption with ≥4 measurement-bearing lines", () => {
    const c = candidate({
      description: [
        "2 cups flour",
        "1 tsp salt",
        "3 tbsp olive oil",
        "200g chicken",
        "and then cook it",
      ].join("\n"),
    });
    expect(hasCaptionRecipe(c)).toBe(true);
  });

  it("returns false for a bare hook caption", () => {
    const c = candidate({ title: "Not 'Marry Me' chicken??? 😰" });
    expect(hasCaptionRecipe(c)).toBe(false);
  });

  it("returns false for empty text", () => {
    expect(hasCaptionRecipe(candidate({}))).toBe(false);
  });
});

// ── narrative extraction + repair + empty→null ────────────────────────────

const EMPTY_RECIPE_JSON = JSON.stringify({
  dish: "Unknown", cuisine: "Unknown", ingredients: [], steps: [],
  prepTime: null, cookTime: null, difficulty: "medium", notes: null,
});

const VALID_RECIPE_JSON = JSON.stringify({
  dish: "Gyoza", cuisine: "Japanese",
  ingredients: [{ item: "pork", qty: "200g" }, { item: "cabbage", qty: "1 cup" }],
  steps: ["mix filling", "fold", "pan-fry"],
  prepTime: "20m", cookTime: "10m", difficulty: "medium", notes: null,
});

/** Queue of `response` strings; each ollamaGenerate (extract) call shifts one. */
function mockOllamaResponses(responses: string[]): { calls: () => number } {
  let n = 0;
  __setRequestUrlImpl(async () => {
    const response = responses[n] ?? responses[responses.length - 1];
    n++;
    return { status: 200, json: { response }, text: "" };
  });
  return { calls: () => n };
}

describe("extractRecipe — narrative + repair + empty→null", () => {
  afterEach(() => __resetRequestUrlImpl());

  it("returns null when both the first attempt and the repair are empty", async () => {
    const m = mockOllamaResponses([EMPTY_RECIPE_JSON, EMPTY_RECIPE_JSON]);
    const result = await extractRecipe(candidate({ description: "narrated dish" }));
    expect(result).toBeNull();
    expect(m.calls()).toBe(2); // first attempt + one repair pass
  });

  it("returns the recipe on the first attempt without a repair pass", async () => {
    const m = mockOllamaResponses([VALID_RECIPE_JSON]);
    const result = await extractRecipe(candidate({ description: "gyoza recipe" }));
    expect(result).not.toBeNull();
    expect(result?.dish).toBe("Gyoza");
    expect(result?.ingredients).toHaveLength(2);
    expect(result?.steps).toHaveLength(3);
    expect(m.calls()).toBe(1); // no repair needed
  });

  it("returns the repaired recipe when the first attempt is empty but the repair succeeds", async () => {
    const m = mockOllamaResponses([EMPTY_RECIPE_JSON, VALID_RECIPE_JSON]);
    const result = await extractRecipe(candidate({ description: "narrated gyoza" }));
    expect(result).not.toBeNull();
    expect(result?.dish).toBe("Gyoza");
    expect(result?.steps).toHaveLength(3);
    expect(m.calls()).toBe(2); // empty first → one repair pass
  });

  it("formats LLM ingredient objects into readable strings (qty item)", async () => {
    const json = JSON.stringify({
      dish: "Butter Toast", cuisine: "American",
      ingredients: [
        { item: "butter", qty: "2 tbsp" },
        { item: "Bread", qty: null },
        { item: "salt", qty: "pinch" },
      ],
      steps: ["Toast bread", "Spread butter"],
      prepTime: null, cookTime: "2m", difficulty: "easy", notes: null,
    });
    mockOllamaResponses([json]);
    const result = await extractRecipe(candidate({ description: "buttered toast recipe" }));
    expect(result).not.toBeNull();
    expect(result?.ingredients).toEqual(["2 tbsp butter", "Bread", "pinch salt"]);
  });

  it("formats LLM ingredient with qty=null as bare item string", async () => {
    const json = JSON.stringify({
      dish: "Simple Salad", cuisine: "American",
      ingredients: [
        { item: "lettuce", qty: null },
        { item: "dressing", qty: "to taste" },
      ],
      steps: ["Toss"],
      prepTime: null, cookTime: null, difficulty: "easy", notes: null,
    });
    mockOllamaResponses([json]);
    const result = await extractRecipe(candidate({ description: "salad recipe" }));
    expect(result).not.toBeNull();
    expect(result?.ingredients).toEqual(["lettuce", "to taste dressing"]);
  });
});
