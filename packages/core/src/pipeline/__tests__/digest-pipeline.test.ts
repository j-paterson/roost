import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { __setRequestUrlImpl, __resetRequestUrlImpl } from "obsidian";
import type { RequestUrlResponse } from "obsidian";
import {
  summarizeCluster,
  __clusterCacheKey,
  runWeeklyDigest,
  extractClaims,
  findRelatedPriorCluster,
  synthesizeStep,
  PRIOR_CLUSTER_SIMILARITY_THRESHOLD,
  PRIOR_LOOKBACK_WEEKS,
  type DigestCandidate,
  type DigestClusterCacheEntry,
  type ExtractedClaim,
  type DigestCache,
  type DigestWeekEntry,
  type SynthesisResult,
} from "@/pipeline/digest-pipeline";
import {
  buildWeeklyDigestNote,
  type DigestWeekContext,
} from "@/pipeline/digest-pipeline";
import type { App, TFile } from "obsidian";

function mkOllamaResponse(jsonStr: string): RequestUrlResponse {
  // Ollama's /api/generate endpoint returns a JSON response where the
  // generation lives in `.response`. The shim's mock is the same shape.
  return {
    status: 200,
    headers: {},
    text: JSON.stringify({ response: jsonStr, done: true }),
    json: { response: jsonStr, done: true },
    arrayBuffer: new ArrayBuffer(0),
  } as RequestUrlResponse;
}

function mkCandidate(overrides: Partial<DigestCandidate>): DigestCandidate {
  return {
    roostId: "x:1",
    file: {} as never,
    title: "default title",
    author: "@author",
    url: "",
    tags: [],
    vec: null,
    bucket: "Macro",
    savedDate: "2026-05-10",
    cover: "",
    ...overrides,
  };
}

describe("__clusterCacheKey", () => {
  it("derives stable hash from bucket + sorted member ids", () => {
    const a = __clusterCacheKey("Macro", ["x:2", "x:1", "x:3"]);
    const b = __clusterCacheKey("Macro", ["x:1", "x:2", "x:3"]);
    expect(a).toBe(b);
  });

  it("differs when bucket differs", () => {
    expect(__clusterCacheKey("Macro", ["x:1"])).not.toBe(
      __clusterCacheKey("Business", ["x:1"]),
    );
  });

  it("differs when members differ", () => {
    expect(__clusterCacheKey("Macro", ["x:1"])).not.toBe(
      __clusterCacheKey("Macro", ["x:2"]),
    );
  });
});

describe("summarizeCluster", () => {
  let calls: number;

  beforeEach(() => {
    calls = 0;
  });

  afterEach(() => {
    __resetRequestUrlImpl();
  });

  it("returns singleton heading without calling LLM", async () => {
    __setRequestUrlImpl(async () => {
      calls++;
      return mkOllamaResponse(`{"headline":"x","why_it_matters":"x","open_question":"x","delta":""}`);
    });

    const cluster = await summarizeCluster(
      [mkCandidate({ roostId: "x:1", title: "Solo item", vec: [1, 0, 0] })],
      [],
      {},
      "2026-05-17",
    );

    expect(cluster.bucket).toBe("Macro");
    expect(cluster.memberIds).toEqual(["x:1"]);
    expect(cluster.headline).toBe("Solo item");
    expect(cluster.whyItMatters).toBe("");
    expect(cluster.openQuestion).toBe("");
    expect(cluster.delta).toBe("");
    expect(cluster.centroid).toEqual([1, 0, 0]);
    expect(calls).toBe(0);
  });

  it("singleton with no embedding stores empty centroid", async () => {
    __setRequestUrlImpl(async () => mkOllamaResponse(`{}`));
    const cluster = await summarizeCluster(
      [mkCandidate({ roostId: "x:1", title: "No vec", vec: null })],
      [],
      {},
      "2026-05-17",
    );
    expect(cluster.centroid).toEqual([]);
  });

  it("calls extract then synthesize for size-2+ clusters", async () => {
    let n = 0;
    __setRequestUrlImpl(async () => {
      n++;
      if (n === 1) {
        return mkOllamaResponse(`{"claims":[{"i":1,"claim":"Claim A."},{"i":2,"claim":"Claim B."}]}`);
      }
      return mkOllamaResponse(
        `{"headline":"Topic","why_it_matters":"Sum.","open_question":"Q?","delta":""}`,
      );
    });

    const cluster = await summarizeCluster(
      [
        mkCandidate({ roostId: "x:1", title: "Item 1", vec: [1, 0, 0] }),
        mkCandidate({ roostId: "x:2", title: "Item 2", vec: [0, 1, 0] }),
      ],
      [],
      {},
      "2026-05-17",
    );

    expect(cluster.headline).toBe("Topic");
    expect(cluster.whyItMatters).toBe("Sum.");
    expect(cluster.openQuestion).toBe("Q?");
    expect(cluster.delta).toBe("");
    expect(cluster.memberIds).toEqual(["x:1", "x:2"]);
    expect(n).toBe(2); // extract + synthesize
  });

  it("reuses cache entry on matching bucket + sorted member ids", async () => {
    __setRequestUrlImpl(async () => {
      calls++;
      return mkOllamaResponse(`{}`);
    });

    const cache: DigestClusterCacheEntry[] = [
      {
        bucket: "Macro",
        memberIds: ["x:1", "x:2"],
        headline: "Cached headline",
        whyItMatters: "Cached body.",
        openQuestion: "Cached Q?",
        delta: "",
        centroid: [1, 1, 0],
      },
    ];

    const cluster = await summarizeCluster(
      [
        mkCandidate({ roostId: "x:2", title: "B", vec: [0, 1, 0] }),
        mkCandidate({ roostId: "x:1", title: "A", vec: [1, 0, 0] }),
      ],
      cache,
      {},
      "2026-05-17",
    );

    expect(cluster.headline).toBe("Cached headline");
    expect(cluster.whyItMatters).toBe("Cached body.");
    expect(cluster.openQuestion).toBe("Cached Q?");
    expect(calls).toBe(0);
  });

  it("falls back to first item title on synthesis failure", async () => {
    let n = 0;
    __setRequestUrlImpl(async () => {
      n++;
      if (n === 1) return mkOllamaResponse(`{"claims":[]}`);
      return mkOllamaResponse(`not json`);
    });

    const cluster = await summarizeCluster(
      [
        mkCandidate({ roostId: "x:1", title: "First", vec: [1, 0, 0] }),
        mkCandidate({ roostId: "x:2", title: "Second", vec: [0, 1, 0] }),
      ],
      [],
      {},
      "2026-05-17",
    );

    expect(cluster.headline).toBe("First");
    expect(cluster.whyItMatters).toBe("(summary unavailable)");
  });
});

function mkCandRow(roostId: string, bucket: string): DigestCandidate {
  return {
    roostId,
    file: { path: `Bookmarks/X/${roostId}/note.md` } as never,
    title: `Title ${roostId}`,
    author: "@a",
    url: "",
    tags: [],
    vec: null,
    bucket,
    savedDate: "2026-05-11",
    cover: "",
  };
}

describe("buildWeeklyDigestNote", () => {
  function mkCtx(overrides: Partial<DigestWeekContext> = {}): DigestWeekContext {
    return {
      weekStart: new Date(2026, 4, 10),
      weekEnd: new Date(2026, 4, 16),
      through: new Date(2026, 4, 12),
      generatedAt: "2026-05-13T08:14:22-07:00",
      bucketCounts: { Macro: 2, Business: 0, Finances: 0, AI: 0, Technology: 0 },
      itemCount: 2,
      clusters: [
        {
          bucket: "Macro",
          memberIds: ["x:1", "x:2"],
          headline: "Fed signals cut",
          whyItMatters: "Two members hinted at a September cut.",
          openQuestion: "Does this hold if labor data disappoints?",
          delta: "Inverts the May 3 pause-and-watch consensus.",
          centroid: [],
        },
      ],
      candidatesByRoostId: new Map([
        [
          "x:1",
          {
            roostId: "x:1",
            file: { path: "Bookmarks/X/twitter-1234/note.md" } as never,
            title: "Fed minutes preview",
            author: "@econ",
            url: "",
            tags: [],
            vec: null,
            bucket: "Macro",
            savedDate: "2026-05-11",
            cover: "",
          },
        ],
        [
          "x:2",
          {
            roostId: "x:2",
            file: { path: "Bookmarks/X/twitter-5678/note.md" } as never,
            title: "Yield curve flattens",
            author: "@invest",
            url: "",
            tags: [],
            vec: null,
            bucket: "Macro",
            savedDate: "2026-05-12",
            cover: "",
          },
        ],
      ]),
      ...overrides,
    };
  }

  it("emits frontmatter including digest_schema_version: 2", () => {
    const md = buildWeeklyDigestNote(mkCtx());
    expect(md).toMatch(/^---\n/);
    expect(md).toContain("roost_digest: weekly");
    expect(md).toContain("digest_schema_version: 2");
    expect(md).toContain("digest_week_start: 2026-05-10");
  });

  it("renders cluster H3 + whyItMatters paragraph + both callouts + roost-card blocks", () => {
    const md = buildWeeklyDigestNote(mkCtx());
    expect(md).toContain("### Fed signals cut");
    expect(md).toContain("Two members hinted at a September cut.");
    expect(md).toContain("> [!info] Δ from prior weeks\n> Inverts the May 3 pause-and-watch consensus.");
    expect(md).toContain("> [!question] Open question\n> Does this hold if labor data disappoints?");
    expect(md).toContain("```roost-card\nBookmarks/X/twitter-1234/note\n```");
  });

  it("omits delta callout when delta is empty", () => {
    const ctx = mkCtx({
      clusters: [
        {
          bucket: "Macro",
          memberIds: ["x:1", "x:2"],
          headline: "Topic",
          whyItMatters: "Body.",
          openQuestion: "Q?",
          delta: "",
          centroid: [],
        },
      ],
    });
    const md = buildWeeklyDigestNote(ctx);
    expect(md).not.toContain("[!info]");
    expect(md).toContain("[!question]");
  });

  it("omits open-question callout when openQuestion is empty", () => {
    const ctx = mkCtx({
      clusters: [
        {
          bucket: "Macro",
          memberIds: ["x:1", "x:2"],
          headline: "Topic",
          whyItMatters: "Body.",
          openQuestion: "",
          delta: "",
          centroid: [],
        },
      ],
    });
    const md = buildWeeklyDigestNote(ctx);
    expect(md).not.toContain("[!question]");
    expect(md).not.toContain("[!info]");
  });

  it("renders singletons without callouts or body paragraph", () => {
    const ctx = mkCtx({
      bucketCounts: { Macro: 1, Business: 0, Finances: 0, AI: 0, Technology: 0 },
      itemCount: 1,
      clusters: [
        {
          bucket: "Macro",
          memberIds: ["x:1"],
          headline: "Solo item",
          whyItMatters: "",
          openQuestion: "",
          delta: "",
          centroid: [],
        },
      ],
      candidatesByRoostId: new Map([
        [
          "x:1",
          {
            roostId: "x:1",
            file: { path: "Bookmarks/X/twitter-1/note.md" } as never,
            title: "Solo item",
            author: "@a",
            url: "",
            tags: [],
            vec: null,
            bucket: "Macro",
            savedDate: "2026-05-11",
            cover: "",
          },
        ],
      ]),
    });
    const md = buildWeeklyDigestNote(ctx);
    expect(md).toContain("### Solo item");
    expect(md).not.toContain("[!info]");
    expect(md).not.toContain("[!question]");
    expect(md).toContain("```roost-card\nBookmarks/X/twitter-1/note\n```");
  });

  it("renders empty buckets with italic placeholder (unchanged)", () => {
    const md = buildWeeklyDigestNote(mkCtx());
    expect(md).toContain("## Business\n*(no items this week)*");
  });

  it("renders H2 in fixed order (unchanged)", () => {
    const md = buildWeeklyDigestNote(mkCtx());
    const lines = md.split("\n");
    const h2Order = lines.filter((l) => l.startsWith("## "));
    expect(h2Order).toEqual([
      "## Macro",
      "## Business",
      "## Finances",
      "## AI",
      "## Technology",
    ]);
  });
});

describe("runWeeklyDigest", () => {
  afterEach(() => __resetRequestUrlImpl());

  // The test exercises orchestration only; vault read/write and embedding-cache
  // loading are stubbed at a layer above what we mock here. For a richer
  // integration we'd need fixture vault scaffolding. This test asserts the
  // result shape when no items are found.
  it("returns empty result when all buckets are empty", async () => {
    __setRequestUrlImpl(async () => mkOllamaResponse(`{"headline":"x","why_it_matters":"x","open_question":"","delta":""}`));
    const app = {
      vault: {
        adapter: {
          exists: async () => false,
          read: async () => "",
          write: async () => {},
        },
        getAbstractFileByPath: () => null,
        getMarkdownFiles: () => [] as TFile[],
        read: async () => "",
        create: async () => ({}),
        modify: async () => {},
      },
      metadataCache: {
        getFileCache: () => null,
      },
    } as unknown as App;

    const result = await runWeeklyDigest(app, "Bookmarks", new Date(2026, 4, 10));

    expect(result.itemCount).toBe(0);
    expect(result.clusterCount).toBe(0);
  });

  it("treats v1 cache entries as cache-miss (forces regenerate)", async () => {
    // Simulate a prior week entry without schemaVersion.
    const adapterContent: Record<string, string> = {
      ".roost/digest-cache.json": JSON.stringify({
        "2026-05-10": {
          weekStart: "2026-05-10",
          weekEnd: "2026-05-16",
          through: "2026-05-16",
          generatedAt: "2026-05-11T08:00:00Z",
          bucketCounts: {},
          processedIds: [],
          clusters: [
            {
              bucket: "Macro",
              memberIds: ["x:1", "x:2"],
              title: "v1 title",  // old shape
              summary: "v1 summary",
            },
          ],
          // No schemaVersion field.
        },
      }),
    };

    __setRequestUrlImpl(async () => mkOllamaResponse(`{"headline":"x","why_it_matters":"x","open_question":"","delta":""}`));
    const app = {
      vault: {
        adapter: {
          exists: async (p: string) => p in adapterContent,
          read: async (p: string) => adapterContent[p] ?? "",
          write: async () => {},
        },
        getAbstractFileByPath: () => null,
        getMarkdownFiles: () => [] as TFile[],
        read: async () => "",
        create: async () => ({}),
        modify: async () => {},
      },
      metadataCache: { getFileCache: () => null },
    } as unknown as App;

    // No candidates produced (empty vault), so we're really testing the
    // result shape + that the schema mismatch doesn't error.
    const result = await runWeeklyDigest(app, "Bookmarks", new Date(2026, 4, 17));
    expect(result.itemCount).toBe(0);
  });
});

describe("extractClaims", () => {
  let calls: number;

  beforeEach(() => {
    calls = 0;
  });

  afterEach(() => {
    __resetRequestUrlImpl();
  });

  it("parses claims from a valid JSON response", async () => {
    __setRequestUrlImpl(async () => {
      calls++;
      return mkOllamaResponse(
        `{"claims":[{"i":1,"claim":"Fed signals September cut."},{"i":2,"claim":"Yield curve flattened to 12bp."}]}`,
      );
    });

    const items = [
      mkCandidate({ roostId: "x:1", title: "Fed minutes preview" }),
      mkCandidate({ roostId: "x:2", title: "Yield curve flattens" }),
    ];

    const result = await extractClaims(items);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual<ExtractedClaim>({ i: 1, claim: "Fed signals September cut." });
    expect(result[1]).toEqual<ExtractedClaim>({ i: 2, claim: "Yield curve flattened to 12bp." });
    expect(calls).toBe(1);
  });

  it("retries once on malformed JSON then returns empty array", async () => {
    __setRequestUrlImpl(async () => {
      calls++;
      return mkOllamaResponse("not json at all");
    });

    const items = [mkCandidate({ roostId: "x:1" })];
    const result = await extractClaims(items);

    expect(result).toEqual([]);
    expect(calls).toBe(2);
  });

  it("returns empty array on succeed-with-wrong-shape", async () => {
    __setRequestUrlImpl(async () => {
      calls++;
      return mkOllamaResponse(`{"wrong":"shape"}`);
    });

    const items = [mkCandidate({ roostId: "x:1" })];
    const result = await extractClaims(items);

    expect(result).toEqual([]);
    expect(calls).toBe(2);
  });

  it("filters out claim entries with non-string text or missing i", async () => {
    __setRequestUrlImpl(async () =>
      mkOllamaResponse(
        `{"claims":[{"i":1,"claim":"Good claim."},{"claim":"Missing i"},{"i":2,"claim":42},{"i":3,"claim":"Another good."}]}`,
      ),
    );

    const items = [mkCandidate({ roostId: "x:1" })];
    const result = await extractClaims(items);

    expect(result).toEqual([
      { i: 1, claim: "Good claim." },
      { i: 3, claim: "Another good." },
    ]);
  });
});

function mkClusterEntry(overrides: {
  bucket: string;
  memberIds?: string[];
  centroid: number[];
  headline?: string;
  whyItMatters?: string;
}) {
  return {
    bucket: overrides.bucket,
    memberIds: overrides.memberIds ?? ["x:1"],
    headline: overrides.headline ?? "Default headline",
    whyItMatters: overrides.whyItMatters ?? "Default body.",
    openQuestion: "",
    delta: "",
    centroid: overrides.centroid,
  };
}

function mkWeekEntry(weekStart: string, clusters: ReturnType<typeof mkClusterEntry>[]): DigestWeekEntry {
  return {
    weekStart,
    weekEnd: weekStart,
    through: weekStart,
    generatedAt: "2026-05-17T00:00:00Z",
    schemaVersion: 2,
    bucketCounts: {},
    processedIds: [],
    clusters,
  };
}

describe("findRelatedPriorCluster", () => {
  it("returns the best-matching cluster above threshold", () => {
    const cache: DigestCache = {
      "2026-05-10": mkWeekEntry("2026-05-10", [
        mkClusterEntry({ bucket: "Macro", centroid: [1, 0, 0], headline: "Match" }),
      ]),
    };
    const result = findRelatedPriorCluster("Macro", [1, 0, 0], cache, "2026-05-17");
    expect(result?.cluster.headline).toBe("Match");
    expect(result?.weekStart).toBe("2026-05-10");
  });

  it("returns null when best similarity is below threshold", () => {
    const cache: DigestCache = {
      "2026-05-10": mkWeekEntry("2026-05-10", [
        mkClusterEntry({ bucket: "Macro", centroid: [0, 1, 0] }),
      ]),
    };
    const result = findRelatedPriorCluster("Macro", [1, 0, 0], cache, "2026-05-17");
    expect(result).toBeNull();
  });

  it("does not cross buckets", () => {
    const cache: DigestCache = {
      "2026-05-10": mkWeekEntry("2026-05-10", [
        mkClusterEntry({ bucket: "Technology", centroid: [1, 0, 0], headline: "Wrong bucket" }),
      ]),
    };
    const result = findRelatedPriorCluster("Macro", [1, 0, 0], cache, "2026-05-17");
    expect(result).toBeNull();
  });

  it("respects PRIOR_LOOKBACK_WEEKS window", () => {
    expect(PRIOR_LOOKBACK_WEEKS).toBe(3);
    const cache: DigestCache = {
      "2026-04-19": mkWeekEntry("2026-04-19", [
        mkClusterEntry({ bucket: "Macro", centroid: [1, 0, 0], headline: "Too old" }),
      ]),
      "2026-04-26": mkWeekEntry("2026-04-26", [
        mkClusterEntry({ bucket: "Macro", centroid: [0, 1, 0] }),
      ]),
      "2026-05-03": mkWeekEntry("2026-05-03", [
        mkClusterEntry({ bucket: "Macro", centroid: [0, 0, 1] }),
      ]),
      "2026-05-10": mkWeekEntry("2026-05-10", [
        mkClusterEntry({ bucket: "Macro", centroid: [0, 0, 1] }),
      ]),
    };
    // Current week 2026-05-17 → lookback covers May 10, May 3, Apr 26.
    // The Apr 19 cluster (perfect match) is outside the window.
    const result = findRelatedPriorCluster("Macro", [1, 0, 0], cache, "2026-05-17");
    expect(result).toBeNull();
  });

  it("returns null when current centroid is empty", () => {
    const cache: DigestCache = {
      "2026-05-10": mkWeekEntry("2026-05-10", [
        mkClusterEntry({ bucket: "Macro", centroid: [1, 0, 0] }),
      ]),
    };
    const result = findRelatedPriorCluster("Macro", [], cache, "2026-05-17");
    expect(result).toBeNull();
  });

  it("skips prior clusters with empty centroid", () => {
    const cache: DigestCache = {
      "2026-05-10": mkWeekEntry("2026-05-10", [
        mkClusterEntry({ bucket: "Macro", centroid: [], headline: "No centroid" }),
        mkClusterEntry({ bucket: "Macro", centroid: [1, 0, 0], headline: "Has centroid" }),
      ]),
    };
    const result = findRelatedPriorCluster("Macro", [1, 0, 0], cache, "2026-05-17");
    expect(result?.cluster.headline).toBe("Has centroid");
  });

  it("threshold is 0.65", () => {
    expect(PRIOR_CLUSTER_SIMILARITY_THRESHOLD).toBe(0.65);
  });
});

describe("synthesizeStep", () => {
  let calls: { url: string; body: string }[];

  beforeEach(() => {
    calls = [];
  });

  afterEach(() => {
    __resetRequestUrlImpl();
  });

  it("synthesizes without prior context: delta is empty", async () => {
    __setRequestUrlImpl(async (opts) => {
      calls.push({ url: opts.url, body: opts.body as string });
      return mkOllamaResponse(
        `{"headline":"Fed signals cut","why_it_matters":"Two members hint at a cut.","open_question":"Does this hold?","delta":""}`,
      );
    });

    const claims: ExtractedClaim[] = [{ i: 1, claim: "Fed signals September cut." }];
    const result = await synthesizeStep(claims, null);

    expect(result).toEqual<SynthesisResult>({
      headline: "Fed signals cut",
      whyItMatters: "Two members hint at a cut.",
      openQuestion: "Does this hold?",
      delta: "",
    });
    // Prompt should NOT mention "prior-week" when prior is null.
    expect(calls[0].body).not.toContain("prior-week");
  });

  it("synthesizes with prior context: delta is populated", async () => {
    __setRequestUrlImpl(async (opts) => {
      calls.push({ url: opts.url, body: opts.body as string });
      return mkOllamaResponse(
        `{"headline":"Fed signals cut","why_it_matters":"Two members.","open_question":"Hold?","delta":"Inverts prior pause-and-watch."}`,
      );
    });

    const claims: ExtractedClaim[] = [{ i: 1, claim: "Fed cut." }];
    const prior = {
      weekStart: "2026-05-03",
      cluster: {
        bucket: "Macro",
        memberIds: ["x:99"],
        headline: "Pause-and-watch consensus",
        whyItMatters: "Minutes read no cut.",
        openQuestion: "",
        delta: "",
        centroid: [1, 0, 0],
      },
    };

    const result = await synthesizeStep(claims, prior);

    expect(result.delta).toBe("Inverts prior pause-and-watch.");
    // Prompt should include the prior context.
    expect(calls[0].body).toContain("Pause-and-watch consensus");
    expect(calls[0].body).toContain("2026-05-03");
  });

  it("retries once on parse failure, then falls back", async () => {
    let count = 0;
    __setRequestUrlImpl(async () => {
      count++;
      return mkOllamaResponse("not json");
    });

    const claims: ExtractedClaim[] = [{ i: 1, claim: "Claim." }];
    const result = await synthesizeStep(claims, null);

    expect(result).toEqual<SynthesisResult>({
      headline: "",
      whyItMatters: "(summary unavailable)",
      openQuestion: "",
      delta: "",
    });
    expect(count).toBe(2);
  });

  it("handles empty claims gracefully (still calls LLM with empty section)", async () => {
    __setRequestUrlImpl(async () =>
      mkOllamaResponse(
        `{"headline":"Topic","why_it_matters":"Sparse.","open_question":"More?","delta":""}`,
      ),
    );

    const result = await synthesizeStep([], null);
    expect(result.headline).toBe("Topic");
  });
});
