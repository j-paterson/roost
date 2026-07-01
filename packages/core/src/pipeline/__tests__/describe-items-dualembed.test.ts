// @vitest-environment node
/**
 * Task 3: Dual-embedding storage (text-only + vision-on)
 *
 * Asserts Stage 2 of embedItem:
 * 1. Calls embedder.embed([visionText, plainText]) — ONE batched call with BOTH strings.
 * 2. visionText includes entry.vision; plainText does NOT.
 * 3. entry.vec  ← result[0] (vision-on embedding)
 * 4. entry.vecText ← result[1] (text-only embedding)
 * 5. Fallback: when plainText.length <= 10, vecText falls back to vec (the vision-on vector).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TFile, Vault } from "obsidian";

// ── Mock shared so we can capture what's written to the cache ──
let savedCache: Record<string, import("@/types/roost").EmbeddingCacheEntry> = {};
vi.mock("@/pipeline/shared", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/pipeline/shared")>();
  return {
    ...real,
    loadEmbeddingCache: vi.fn(() => savedCache),
    saveEmbeddingCache: vi.fn((_vault: unknown, cache: typeof savedCache) => {
      savedCache = { ...cache };
    }),
  };
});

vi.mock("@/lib/vault-utils", () => ({
  getSyncFiles: (vault: Vault) => (vault as any).__fakeFiles ?? [],
  vaultBasePath: () => "/fake/vault",
}));

vi.mock("child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("child_process")>();
  return { ...real, execFileSync: vi.fn(() => { throw new Error("execFileSync should not be called"); }) };
});

vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  return { ...real, readdirSync: vi.fn(() => []) };
});

// No LLM calls — we want a pre-seeded cache so Stages 1a/1b are skipped.
import { __setRequestUrlImpl, __resetRequestUrlImpl } from "obsidian";
import { describeItems } from "@/pipeline/describe-items";
import { __resetEmbeddingCache } from "@/pipeline/shared";

// ── Deterministic mock embedder ──
// Returns a vector whose first element is 1.0 when the input contains the
// vision sentinel, and 2.0 otherwise — so the test can distinguish them.
const VISION_SENTINEL = "UNIQUE_VISION_TEXT_abc123";
function makeEmbedder() {
  const embedCalls: string[][] = [];
  const embedder = {
    get calls() { return embedCalls; },
    embed: vi.fn(async (texts: string[]) => {
      embedCalls.push([...texts]);
      return texts.map((t) => {
        const marker = t.includes(VISION_SENTINEL) ? 1.0 : 2.0;
        return new Array(768).fill(marker);
      });
    }),
  };
  return embedder;
}

function makeFakeVault(): Vault {
  const v = new Vault() as any;
  v.getAbstractFileByPath = () => null;
  v.readBinary = async () => new ArrayBuffer(0);
  return v as Vault;
}

function makeApp(fileStub: TFile, frontmatter: Record<string, unknown>) {
  return {
    metadataCache: {
      getFileCache: (f: TFile) => (f === fileStub ? { frontmatter } : null),
    },
  };
}

describe("Stage 2: dual-embedding (text-only + vision-on)", () => {
  beforeEach(() => {
    savedCache = {};
    __resetEmbeddingCache();
    // LLM stubs — only needed if stages 1a/1b fire, but we seed the cache so they skip.
    __setRequestUrlImpl(async () => ({
      status: 200,
      json: { response: "Topic: test\nCategory: Test" },
      text: "",
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
    }));
  });

  afterEach(() => {
    __resetRequestUrlImpl();
    vi.clearAllMocks();
  });

  it("calls embed ONCE with both vision-on and plain-text strings", async () => {
    // Pre-seed: vision is already set (Stage 1a done), summary/category set (Stage 1b done),
    // but vec is null → Stage 2 must run.
    savedCache["test:1"] = {
      vision: VISION_SENTINEL,
      summary: "A summary of the content",
      category: "Education",
      vec: null,
      vecText: null,
    };

    const vault = makeFakeVault();
    const fakeFile = new TFile() as TFile & { path: string };
    fakeFile.path = "Bookmarks/item1.md";
    (vault as any).__fakeFiles = [fakeFile];

    const app = makeApp(fakeFile, {
      roost_id: "test:1",
      title: "My Title",
      subtitle: "My Subtitle",
    });

    const embedder = makeEmbedder();
    await describeItems({
      vault,
      app: app as any,
      syncFolder: "Bookmarks",
      ollamaUrl: "http://localhost:11434",
      embedder: embedder as any,
    });

    // ONE call to embed with exactly TWO strings
    expect(embedder.calls.length).toBe(1);
    expect(embedder.calls[0].length).toBe(2);

    const [visionText, plainText] = embedder.calls[0];

    // visionText must include entry.vision
    expect(visionText).toContain(VISION_SENTINEL);
    // plainText must NOT include entry.vision
    expect(plainText).not.toContain(VISION_SENTINEL);
    // Both must contain other fields
    expect(visionText).toContain("A summary of the content");
    expect(plainText).toContain("A summary of the content");
  });

  it("stores vec (vision-on) and vecText (text-only) in the cache entry", async () => {
    savedCache["test:1"] = {
      vision: VISION_SENTINEL,
      summary: "Summary text here",
      category: "Education",
      vec: null,
      vecText: null,
    };

    const vault = makeFakeVault();
    const fakeFile = new TFile() as TFile & { path: string };
    fakeFile.path = "Bookmarks/item1.md";
    (vault as any).__fakeFiles = [fakeFile];
    const app = makeApp(fakeFile, { roost_id: "test:1", title: "Title" });

    const embedder = makeEmbedder();
    await describeItems({
      vault,
      app: app as any,
      syncFolder: "Bookmarks",
      ollamaUrl: "http://localhost:11434",
      embedder: embedder as any,
    });

    const entry = savedCache["test:1"];
    expect(entry).toBeDefined();

    // vec[0] === 1.0 → built from the vision-on string (contains VISION_SENTINEL)
    expect(entry.vec).not.toBeNull();
    expect(entry.vec![0]).toBeCloseTo(1.0);

    // vecText[0] === 2.0 → built from the plain-text string (no VISION_SENTINEL)
    expect(entry.vecText).not.toBeNull();
    expect(entry.vecText![0]).toBeCloseTo(2.0);
  });

  it("content-less item (no title/vision/summary) still gets a vec via identity fallback — never stuck", async () => {
    // A deleted post: media never downloaded, no caption, empty title. Without the
    // identity fallback its visionText is empty, no vector is written, and it is
    // re-counted as "needs embedding" forever.
    savedCache["instagram:dead"] = {
      vision: null, summary: null, category: null, vec: null, vecText: null,
    };

    const vault = makeFakeVault();
    const fakeFile = new TFile() as TFile & { path: string };
    fakeFile.path = "Bookmarks/Instagram/dead.md";
    (vault as any).__fakeFiles = [fakeFile];
    const app = makeApp(fakeFile, {
      roost_id: "instagram:dead",
      title: "",
      author: "[[People/@allmodern]]",
      platform: "instagram",
      tags: ["instagram"],
    });

    const embedder = makeEmbedder();
    await describeItems({
      vault,
      app: app as any,
      syncFolder: "Bookmarks",
      ollamaUrl: "http://localhost:11434",
      embedder: embedder as any,
    });

    const entry = savedCache["instagram:dead"];
    expect(entry).toBeDefined();
    expect(entry.vec).not.toBeNull();      // got a vector → drops out of "needs embedding"
    expect(entry.vecText).not.toBeNull();
    // The fallback embed used the item identity (author handle + platform), stripped of wikilink.
    const embedded = embedder.calls[0].join(" ");
    expect(embedded).toContain("@allmodern");
    expect(embedded).toContain("instagram");
    expect(embedded).not.toContain("[[People");
  });

  it("a numeric frontmatter title (parsed as a JS number) still embeds — never stuck", async () => {
    // Regression: a counting-subreddit post whose title is "16367" is parsed by
    // Obsidian's metadata cache as the NUMBER 16367. The topic stage builds
    // `Post text: "${item.text.slice(0,500)}"` OUTSIDE its try/catch — so a
    // number title threw TypeError, rejected embedItem, and the item was
    // recounted as "needs embedding" on every run forever. Coercing title to a
    // string at the source fixes it.
    savedCache["reddit:1nm4h1d"] = {
      vision: null, summary: null, category: null, vec: null, vecText: null,
    };

    const vault = makeFakeVault();
    const fakeFile = new TFile() as TFile & { path: string };
    fakeFile.path = "Bookmarks/Reddit/numeric.md";
    (vault as any).__fakeFiles = [fakeFile];
    // title is a NUMBER, not a string — the exact shape the metadata cache produces.
    const app = makeApp(fakeFile, {
      roost_id: "reddit:1nm4h1d",
      title: 16367,
      author: "[[People/@Cheezba11]]",
      platform: "reddit",
      tags: ["reddit", "subreddit/countwithchickenlady"],
    });

    const embedder = makeEmbedder();
    const result = await describeItems({
      vault,
      app: app as any,
      syncFolder: "Bookmarks",
      ollamaUrl: "http://localhost:11434",
      embedder: embedder as any,
    });

    const entry = savedCache["reddit:1nm4h1d"];
    expect(entry).toBeDefined();
    expect(entry.vec).not.toBeNull();       // got a vector → drops out of "needs embedding"
    expect(entry.vecText).not.toBeNull();
    expect(result.errors).toBe(0);          // did not fail on the numeric title
    // The numeric title reached the embed input as a string, not a crash.
    expect(embedder.calls[0].join(" ")).toContain("16367");
  });

  it("a hung embed call times out instead of hanging the whole run", async () => {
    vi.useFakeTimers();
    try {
      // Seed vision+summary so only Stage 2 (embed) runs; make embed never resolve.
      savedCache["test:hang"] = {
        vision: null, summary: "A summary that is definitely longer than ten chars", category: "X", vec: null, vecText: null,
      };
      const vault = makeFakeVault();
      const fakeFile = new TFile() as TFile & { path: string };
      fakeFile.path = "Bookmarks/hang.md";
      (vault as any).__fakeFiles = [fakeFile];
      const app = makeApp(fakeFile, { roost_id: "test:hang", title: "A title clearly longer than ten characters" });

      const embedder = { embed: vi.fn(() => new Promise<number[][]>(() => { /* never resolves */ })) };
      const runP = describeItems({
        vault, app: app as any, syncFolder: "Bookmarks", ollamaUrl: "http://localhost:11434", embedder: embedder as any,
      });

      // Fast-forward past the stage timeout for the initial attempt AND the retry pass.
      await vi.advanceTimersByTimeAsync(120_000);
      await vi.advanceTimersByTimeAsync(120_000);

      const result = await runP;               // resolves — did NOT hang
      expect(result.errors).toBeGreaterThan(0); // the item failed gracefully
      expect(savedCache["test:hang"].vec).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves existing entry.vec when backfilling vecText (vec must not be overwritten)", async () => {
    // Sentinel vector — a recognisable value that must survive the backfill path.
    const SENTINEL_VEC = new Array(768).fill(0.42);
    savedCache["test:backfill"] = {
      vision: null,
      summary: "A detailed summary that is definitely longer than ten chars",
      category: "Science",
      vec: [...SENTINEL_VEC], // already present — must NOT be recomputed
      vecText: null,          // missing — must be backfilled
    };

    const vault = makeFakeVault();
    const fakeFile = new TFile() as TFile & { path: string };
    fakeFile.path = "Bookmarks/backfill.md";
    (vault as any).__fakeFiles = [fakeFile];
    const app = makeApp(fakeFile, {
      roost_id: "test:backfill",
      title: "Some Title That Is Clearly Longer Than Ten Characters",
    });

    const embedder = makeEmbedder();
    await describeItems({
      vault,
      app: app as any,
      syncFolder: "Bookmarks",
      ollamaUrl: "http://localhost:11434",
      embedder: embedder as any,
    });

    const entry = savedCache["test:backfill"];
    expect(entry).toBeDefined();

    // vec must be identical to the seeded sentinel — never recomputed
    expect(entry.vec).not.toBeNull();
    expect(entry.vec!.length).toBe(768);
    expect(entry.vec![0]).toBeCloseTo(0.42);
    expect(entry.vec).toEqual(SENTINEL_VEC);

    // vecText must now be set (backfilled)
    expect(entry.vecText).not.toBeNull();

    // Only ONE embed call — the single plainText call, not a batched [visionText, plainText]
    expect(embedder.calls.length).toBe(1);
    expect(embedder.calls[0].length).toBe(1);
  });

  it("falls back vecText = vec when plainText is too short (length <= 10)", async () => {
    // Pre-seed with vision set but NO summary/category so Stage 1b is also skipped.
    // title will be empty → plainText will be "" (length 0 ≤ 10).
    // Only the vision field populates visionText, so visionText.length > 10 still holds.
    savedCache["test:2"] = {
      vision: VISION_SENTINEL,
      summary: "ok",         // summary IS set so Stage 1b is skipped
      category: null,
      vec: null,
      vecText: null,
    };

    const vault = makeFakeVault();
    const fakeFile = new TFile() as TFile & { path: string };
    fakeFile.path = "Bookmarks/item2.md";
    (vault as any).__fakeFiles = [fakeFile];
    // No title, no subtitle → item.text = "", item.subtitle = ""
    // plainText = [summary="ok", category=null, text="", subtitle=""].filter(Boolean) = ["ok"]
    // "ok".length = 2 ≤ 10 → fallback path
    const app = makeApp(fakeFile, { roost_id: "test:2" });

    const embedder = makeEmbedder();
    await describeItems({
      vault,
      app: app as any,
      syncFolder: "Bookmarks",
      ollamaUrl: "http://localhost:11434",
      embedder: embedder as any,
    });

    const entry = savedCache["test:2"];
    expect(entry).toBeDefined();

    // vec should be non-null (vision-on text includes VISION_SENTINEL)
    expect(entry.vec).not.toBeNull();
    expect(entry.vec![0]).toBeCloseTo(1.0);

    // vecText should fall back to vec (same reference or same values)
    expect(entry.vecText).not.toBeNull();
    expect(entry.vecText![0]).toBeCloseTo(1.0);
  });
});
