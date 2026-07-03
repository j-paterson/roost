/**
 * Tests for the filed-category branch in the five embedded-only pipelines.
 *
 * Per plan 053: places, products, workouts, tutorials, and home pipelines should
 * gather candidates whose roost_category (or roost_subcategory) matches the
 * pipeline's categoryMatches set, even when the embedding category / tags do NOT.
 *
 * Modelled after the recipe filed-category tests in recipe-pipeline-integration.test.ts.
 */
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileSystemAdapter, TFile } from "obsidian";

import {
  gatherPlaceCandidateIds,
  FILED_PLACE_CATEGORIES,
  PLACE_ENRICHMENT,
} from "@/pipeline/places-pipeline";
import {
  gatherProductCandidateIds,
  FILED_PRODUCT_CATEGORIES,
  PRODUCT_ENRICHMENT,
} from "@/pipeline/products-pipeline";
import {
  gatherWorkoutCandidateIds,
  FILED_WORKOUT_CATEGORIES,
  WORKOUT_ENRICHMENT,
} from "@/pipeline/workouts-pipeline";
import {
  gatherTutorialCandidateIds,
  FILED_TUTORIAL_CATEGORIES,
  TUTORIAL_ENRICHMENT,
} from "@/pipeline/tutorials-pipeline";
import {
  gatherHomeCandidateIds,
  FILED_HOME_CATEGORIES,
  HOME_ENRICHMENT,
} from "@/pipeline/home-pipeline";
import {
  gatherRecipeCandidateIds,
  FILED_RECIPE_CATEGORIES,
  RECIPE_ENRICHMENT,
} from "@/pipeline/recipe-pipeline";
import {
  gatherMediaCandidateIds,
  FILED_MEDIA_CATEGORIES,
  MEDIA_EXTRACTION_ENRICHMENT,
} from "@/pipeline/media-pipeline";
import { __resetEmbeddingCache } from "@/pipeline/shared";

// ── Minimal fake App factory ──

/**
 * Build a minimal fake App where:
 *   - one bookmark note is stored on disk and registered in the metadata cache
 *   - the embedding cache is seeded with the given embeddedCategory
 *   - frontmatterExtra lets callers inject roost_category / roost_subcategory
 */
function makeApp(
  baseDir: string,
  roostId: string,
  embeddedCategory: string,
  frontmatterExtra: Record<string, string> = {},
) {
  const syncFolder = "Bookmarks";
  const shortId = roostId.replace(/^\w+:/, "");
  const relPath = `${syncFolder}/TikTok/tiktok-${shortId}/note.md`;

  const fmLines = [`roost_id: ${roostId}`, `title: Test note`];
  for (const [k, v] of Object.entries(frontmatterExtra)) {
    fmLines.push(`${k}: "${v}"`);
  }
  const noteContent = `---\n${fmLines.join("\n")}\n---\n`;

  // Write note to disk (needed for buildFileIndex)
  const noteDir = path.join(baseDir, path.dirname(relPath));
  fs.mkdirSync(noteDir, { recursive: true });
  fs.writeFileSync(path.join(baseDir, relPath), noteContent);

  // Seed embedding cache
  const cacheDir = path.join(baseDir, ".roost", "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const embeddingCache: Record<string, unknown> = {
    [roostId]: { category: embeddedCategory, vision: "", summary: "", vec: null },
  };
  fs.writeFileSync(
    path.join(cacheDir, "embedding-cache.json"),
    JSON.stringify(embeddingCache),
  );
  // Minimal vector file (just the header)
  const header = Buffer.from(JSON.stringify([roostId]) + "\n", "utf8");
  const floatBuf = Buffer.alloc(768 * 4, 0);
  fs.writeFileSync(
    path.join(cacheDir, "embedding-vectors.bin"),
    Buffer.concat([header, floatBuf]),
  );

  const files = new Map<string, string>([[relPath, noteContent]]);

  const adapter = new FileSystemAdapter();
  adapter.basePath = baseDir;

  const vault = {
    adapter,
    getAbstractFileByPath: (p: string) =>
      files.has(p) ? (Object.assign(new TFile(), { path: p }) as unknown) : null,
    getMarkdownFiles: () =>
      Array.from(files.keys())
        .filter(p => p.endsWith(".md"))
        .map(p => Object.assign(new TFile(), { path: p })),
  };

  const metadataCache = {
    getFileCache: (f: unknown) => {
      const content = files.get((f as { path: string }).path) ?? "";
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) return null;
      const fm: Record<string, unknown> = {};
      for (const line of fmMatch[1].split("\n")) {
        const m = line.match(/^([\w][\w_]*):\s*"?([^"]+)"?$/);
        if (m) fm[m[1]] = m[2].trim();
      }
      return { frontmatter: fm };
    },
  };

  const app = { vault, metadataCache } as unknown as Parameters<typeof gatherPlaceCandidateIds>[0];
  return { app, syncFolder };
}

// ── Test helpers ──

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roost-filed-cat-"));
  __resetEmbeddingCache();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  __resetEmbeddingCache();
});

// ── Places pipeline ──

describe("gatherPlaceCandidateIds — filed-category branch", () => {
  it("gathers item whose roost_category matches categoryMatches even with non-place embedded.category", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:p1", "unrelated-thing", {
      roost_category: "Places",
    });
    const ids = gatherPlaceCandidateIds(app, syncFolder);
    expect(ids.has("tiktok:p1")).toBe(true);
  });

  it("gathers item whose roost_subcategory matches categoryMatches", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:p2", "unrelated-thing", {
      roost_subcategory: "Travel",
    });
    const ids = gatherPlaceCandidateIds(app, syncFolder);
    expect(ids.has("tiktok:p2")).toBe(true);
  });

  it("does NOT gather item with no filed category", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:p3", "random-unrelated-thing");
    const ids = gatherPlaceCandidateIds(app, syncFolder);
    expect(ids.has("tiktok:p3")).toBe(false);
  });

  it("does NOT gather on content category alone (no filed category)", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:p9", "architecture");
    expect(gatherPlaceCandidateIds(app, syncFolder).has("tiktok:p9")).toBe(false);
  });

  it("FILED_PLACE_CATEGORIES matches PLACE_ENRICHMENT.categoryMatches (single source of truth)", () => {
    const fromGate = [...FILED_PLACE_CATEGORIES].sort();
    const fromRegistry = (PLACE_ENRICHMENT.categoryMatches ?? [])
      .map(c => c.toLowerCase())
      .sort();
    expect(fromRegistry).toEqual(fromGate);
  });
});

// ── Products pipeline ──

describe("gatherProductCandidateIds — filed-category branch", () => {
  it("gathers item whose roost_category matches categoryMatches even with non-product embedded.category", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:pr1", "unrelated-thing", {
      roost_category: "Products",
    });
    const ids = gatherProductCandidateIds(app, syncFolder);
    expect(ids.has("tiktok:pr1")).toBe(true);
  });

  it("gathers item whose roost_subcategory matches categoryMatches", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:pr2", "unrelated-thing", {
      roost_subcategory: "Gear",
    });
    const ids = gatherProductCandidateIds(app, syncFolder);
    expect(ids.has("tiktok:pr2")).toBe(true);
  });

  it("does NOT gather item with no filed category", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:pr3", "random-unrelated-thing");
    const ids = gatherProductCandidateIds(app, syncFolder);
    expect(ids.has("tiktok:pr3")).toBe(false);
  });

  it("does NOT gather on content category alone (no filed category)", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:pr9", "gadget");
    expect(gatherProductCandidateIds(app, syncFolder).has("tiktok:pr9")).toBe(false);
  });

  it("FILED_PRODUCT_CATEGORIES matches PRODUCT_ENRICHMENT.categoryMatches (single source of truth)", () => {
    const fromGate = [...FILED_PRODUCT_CATEGORIES].sort();
    const fromRegistry = (PRODUCT_ENRICHMENT.categoryMatches ?? [])
      .map(c => c.toLowerCase())
      .sort();
    expect(fromRegistry).toEqual(fromGate);
  });
});

// ── Workouts pipeline ──

describe("gatherWorkoutCandidateIds — filed-category branch", () => {
  it("gathers item whose roost_category matches categoryMatches even with non-workout embedded.category", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:w1", "unrelated-thing", {
      roost_category: "Fitness",
    });
    const ids = gatherWorkoutCandidateIds(app, syncFolder);
    expect(ids.has("tiktok:w1")).toBe(true);
  });

  it("gathers item whose roost_subcategory matches categoryMatches", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:w2", "unrelated-thing", {
      roost_subcategory: "Workout",
    });
    const ids = gatherWorkoutCandidateIds(app, syncFolder);
    expect(ids.has("tiktok:w2")).toBe(true);
  });

  it("does NOT gather item with no filed category", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:w3", "random-unrelated-thing");
    const ids = gatherWorkoutCandidateIds(app, syncFolder);
    expect(ids.has("tiktok:w3")).toBe(false);
  });

  it("does NOT gather on content category alone (no filed category)", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:w9", "yoga");
    expect(gatherWorkoutCandidateIds(app, syncFolder).has("tiktok:w9")).toBe(false);
  });

  it("FILED_WORKOUT_CATEGORIES matches WORKOUT_ENRICHMENT.categoryMatches (single source of truth)", () => {
    const fromGate = [...FILED_WORKOUT_CATEGORIES].sort();
    const fromRegistry = (WORKOUT_ENRICHMENT.categoryMatches ?? [])
      .map(c => c.toLowerCase())
      .sort();
    expect(fromRegistry).toEqual(fromGate);
  });
});

// ── Tutorials pipeline ──

describe("gatherTutorialCandidateIds — filed-category branch", () => {
  it("gathers item whose roost_category matches categoryMatches even with non-tutorial embedded.category", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:t1", "unrelated-thing", {
      roost_category: "Tutorials",
    });
    const ids = gatherTutorialCandidateIds(app, syncFolder);
    expect(ids.has("tiktok:t1")).toBe(true);
  });

  it("gathers item whose roost_subcategory matches categoryMatches", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:t2", "unrelated-thing", {
      roost_subcategory: "How-To",
    });
    const ids = gatherTutorialCandidateIds(app, syncFolder);
    expect(ids.has("tiktok:t2")).toBe(true);
  });

  it("does NOT gather item with no filed category", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:t3", "random-unrelated-thing");
    const ids = gatherTutorialCandidateIds(app, syncFolder);
    expect(ids.has("tiktok:t3")).toBe(false);
  });

  it("does NOT gather on content category alone (no filed category)", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:t9", "coding");
    expect(gatherTutorialCandidateIds(app, syncFolder).has("tiktok:t9")).toBe(false);
  });

  it("FILED_TUTORIAL_CATEGORIES matches TUTORIAL_ENRICHMENT.categoryMatches (single source of truth)", () => {
    const fromGate = [...FILED_TUTORIAL_CATEGORIES].sort();
    const fromRegistry = (TUTORIAL_ENRICHMENT.categoryMatches ?? [])
      .map(c => c.toLowerCase())
      .sort();
    expect(fromRegistry).toEqual(fromGate);
  });
});

// ── Home pipeline ──

describe("gatherHomeCandidateIds — filed-category branch", () => {
  it("gathers item whose roost_category matches categoryMatches even with non-home embedded.category", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:h1", "unrelated-thing", {
      roost_category: "Home",
    });
    const ids = gatherHomeCandidateIds(app, syncFolder);
    expect(ids.has("tiktok:h1")).toBe(true);
  });

  it("gathers item whose roost_subcategory matches categoryMatches", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:h2", "unrelated-thing", {
      roost_subcategory: "Decor",
    });
    const ids = gatherHomeCandidateIds(app, syncFolder);
    expect(ids.has("tiktok:h2")).toBe(true);
  });

  it("gathers item whose roost_category is 'Home & Interiors' (compound label)", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:h4", "unrelated-thing", {
      roost_category: "Home & Interiors",
    });
    const ids = gatherHomeCandidateIds(app, syncFolder);
    expect(ids.has("tiktok:h4")).toBe(true);
  });

  it("does NOT gather item with no filed category", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:h3", "random-unrelated-thing");
    const ids = gatherHomeCandidateIds(app, syncFolder);
    expect(ids.has("tiktok:h3")).toBe(false);
  });

  it("does NOT gather on content category alone (no filed category)", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:h9", "furniture");
    expect(gatherHomeCandidateIds(app, syncFolder).has("tiktok:h9")).toBe(false);
  });

  it("FILED_HOME_CATEGORIES matches HOME_ENRICHMENT.categoryMatches (single source of truth)", () => {
    const fromGate = [...FILED_HOME_CATEGORIES].sort();
    const fromRegistry = (HOME_ENRICHMENT.categoryMatches ?? [])
      .map(c => c.toLowerCase())
      .sort();
    expect(fromRegistry).toEqual(fromGate);
  });
});

// ── Recipe pipeline ──

describe("gatherRecipeCandidateIds — filed-category branch", () => {
  it("gathers item whose roost_category matches categoryMatches even with non-recipe embedded.category", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:r1", "unrelated-thing", {
      roost_category: "Recipes",
    });
    expect(gatherRecipeCandidateIds(app, syncFolder).has("tiktok:r1")).toBe(true);
  });

  it("does NOT gather on content category alone (no filed category)", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:r9", "baking");
    expect(gatherRecipeCandidateIds(app, syncFolder).has("tiktok:r9")).toBe(false);
  });

  it("FILED_RECIPE_CATEGORIES matches RECIPE_ENRICHMENT.categoryMatches (single source of truth)", () => {
    const fromGate = [...FILED_RECIPE_CATEGORIES].sort();
    const fromRegistry = (RECIPE_ENRICHMENT.categoryMatches ?? []).map(c => c.toLowerCase()).sort();
    expect(fromRegistry).toEqual(fromGate);
  });
});

// ── Media pipeline ──

describe("gatherMediaCandidateIds — filed-category gate", () => {
  it("gathers item filed under a media category (e.g. roost_category: Media)", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:m1", "unrelated-thing", {
      roost_category: "Media",
    });
    expect(gatherMediaCandidateIds(app, syncFolder).has("tiktok:m1")).toBe(true);
  });

  it("gathers item whose roost_subcategory is a music subcategory (playback routing)", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:m2", "unrelated-thing", {
      roost_subcategory: "Music",
    });
    expect(gatherMediaCandidateIds(app, syncFolder).has("tiktok:m2")).toBe(true);
  });

  it("does NOT gather on content category alone (no filed category)", () => {
    const { app, syncFolder } = makeApp(tmp, "tiktok:m9", "podcast");
    expect(gatherMediaCandidateIds(app, syncFolder).has("tiktok:m9")).toBe(false);
  });

  it("FILED_MEDIA_CATEGORIES matches MEDIA_EXTRACTION_ENRICHMENT.categoryMatches (single source of truth)", () => {
    const fromGate = [...FILED_MEDIA_CATEGORIES].sort();
    const fromRegistry = (MEDIA_EXTRACTION_ENRICHMENT.categoryMatches ?? []).map(c => c.toLowerCase()).sort();
    expect(fromRegistry).toEqual(fromGate);
  });
});
