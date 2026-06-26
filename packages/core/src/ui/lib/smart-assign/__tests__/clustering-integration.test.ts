/**
 * Integration tests for the Smart-Assign clustering pipeline:
 * runClusteringStep0Embed → runClusteringStep1ScoreKnown → runClusteringStep2DiscoverAndScore
 * (and the full orchestrator runSmartAssignClustering).
 *
 * Strategy:
 * - Disk isolation: each test gets its own mkdtemp directory as the vault basePath.
 * - Embedding skip: vault.getMarkdownFiles() returns [] so describeItems is a no-op.
 * - Cache seam: we install the embedding cache via saveEmbeddingCache() before each run.
 * - LLM mock: __setRequestUrlImpl intercepts all Ollama calls. For known items we return
 *   matching T1/T2 letters (agree → always accepted). For fit* items we return disagreeing
 *   T1/T2 letters so the disagree+low-sim gate fires → conditionalReject → unmatched.
 *
 * Vec geometry (768-dim):
 * - Cooking items: strongly anchored at dim 0 (oneHot(0))
 * - Travel items: strongly anchored at dim 1 (oneHot(1))
 * - Fitness items: strongly anchored at dim 2 (oneHot(2)) — orthogonal to both
 *
 * The TestEmbedder must return 768-dim vectors (same as item vecs) so that
 * anchor-name embeddings blend correctly in buildCategoryDefs. We map known
 * strings to separated oneHot positions so the taxonomy HDBSCAN doesn't merge them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileSystemAdapter, __setRequestUrlImpl, __resetRequestUrlImpl } from "obsidian";
import { saveEmbeddingCache, __resetEmbeddingCache } from "@/pipeline/shared";
import { __resetScoreCacheForTests } from "@/pipeline/evaluate";
import { runSmartAssignClustering, type SmartAssignClusteringHost } from "@/ui/lib/smart-assign/clustering";
import { runClusteringStep0Embed } from "@/ui/lib/smart-assign/clustering-step-0-embed";
import { runClusteringStep1ScoreKnown } from "@/ui/lib/smart-assign/clustering-step-1-score";
import { runClusteringStep2DiscoverAndScore } from "@/ui/lib/smart-assign/clustering-step-2-discover";
import type { EmbeddingCacheEntry, SmartAssignInput, ClassifyProposalData } from "@/types/roost";
import type { Embedder } from "@/lib/embedder";
import type { StopSignal } from "@/types/sync";

// ── Vec helpers (768-dim to match item vecs) ──────────────────

const DIM = 768;

/**
 * One-hot 768-dim vector at position `pos`. Near-zero epsilon for all others.
 * Gives maximum cosine separation between different positions.
 */
function oneHot(pos: number, dim = DIM): number[] {
  const v = new Array(dim).fill(0.001);
  v[pos] = 1.0;
  return v;
}

/** Small perturbation of oneHot(pos): still very high cosine similarity. */
function nearOneHot(pos: number, offset: number, dim = DIM): number[] {
  const v = oneHot(pos, dim);
  v[(pos + 1) % dim] += offset * 0.02;  // tiny perturbation to maintain high cohesion
  return v;
}

// ── TestEmbedder ──────────────────────────────────────────────
//
// The embedder is called for:
// 1. fillMissingAnchorNames: collection/category names like "Cooking", "Travel", "Fitness"
// 2. embedCategories (taxonomy): normalized strings like "cooking", "travel", "fitness"
//
// We must return 768-dim vectors so they blend correctly with item centroids.
// We map known strings to well-separated oneHot positions so the taxonomy
// doesn't merge Cooking/Travel/Fitness into one cluster.

const EMBED_MAP: Record<string, number> = {
  // anchor names (fillMissingAnchorNames uses capitalized names, lowercased to key)
  cooking: 0,
  travel: 1,
  fitness: 2,
  // taxonomy uses lowercase normalized strings
  library: 3,
};

class TestEmbedder implements Embedder {
  readonly name = "test";
  readonly ready = true;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(t => {
      const key = t.toLowerCase().trim();
      const pos = EMBED_MAP[key] ?? 7;  // unknown strings → dim 7 (out of the way)
      return oneHot(pos, DIM);
    });
  }

  dispose(): void {}
}

// ── Disk-isolated vault ───────────────────────────────────────

let tmpDir: string;

function mkVault() {
  const adapter = new FileSystemAdapter();
  (adapter as unknown as { basePath: string }).basePath = tmpDir;
  return {
    adapter,
    getMarkdownFiles: () => [],   // makes describeItems a no-op
  } as unknown as import("obsidian").Vault;
}

function mkApp(vault: ReturnType<typeof mkVault>) {
  return {
    vault,
    metadataCache: { getFileCache: () => null },
  } as unknown as import("obsidian").App;
}

// ── Embedding cache fixtures ──────────────────────────────────
//
// 4 anchors (2 Cooking, 2 Travel) + 7 targets (1 Cooking, 1 Travel, 5 Fitness)
// All fit* items are near-identical → high cohesion cluster → survives discovery gate

function seedCache(): Record<string, EmbeddingCacheEntry> {
  return {
    // Known collection anchors
    cook1: { vision: null, summary: "pasta carbonara recipe", category: "Cooking", vec: oneHot(0), vecText: null },
    cook2: { vision: null, summary: "chocolate cake baking tutorial", category: "Cooking", vec: nearOneHot(0, 0.1), vecText: null },
    trav1: { vision: null, summary: "best beaches in Portugal travel guide", category: "Travel", vec: oneHot(1), vecText: null },
    trav2: { vision: null, summary: "Tokyo street food tour", category: "Travel", vec: nearOneHot(1, 0.1), vecText: null },
    // Target items to classify
    t_cook: { vision: null, summary: "homemade sourdough bread recipe", category: "Cooking", vec: nearOneHot(0, 0.5), vecText: null },
    t_trav: { vision: null, summary: "hidden gems in Barcelona", category: "Travel", vec: nearOneHot(1, 0.5), vecText: null },
    // Fitness items — orthogonal to Cooking/Travel; near-identical vecs for high cohesion
    fit1: { vision: null, summary: "morning HIIT workout routine for beginners", category: "Fitness", vec: oneHot(2), vecText: null },
    fit2: { vision: null, summary: "10 minute abs workout no equipment needed", category: "Fitness", vec: nearOneHot(2, 0.1), vecText: null },
    fit3: { vision: null, summary: "yoga flow for flexibility and strength", category: "Fitness", vec: nearOneHot(2, 0.2), vecText: null },
    fit4: { vision: null, summary: "full body strength training guide", category: "Fitness", vec: nearOneHot(2, 0.3), vecText: null },
    fit5: { vision: null, summary: "running tips to improve your pace", category: "Fitness", vec: nearOneHot(2, 0.4), vecText: null },
  };
}

const TEST_INPUT: SmartAssignInput = {
  itemIds: ["t_cook", "t_trav", "fit1", "fit2", "fit3", "fit4", "fit5"],
  collections: { Cooking: ["cook1", "cook2"], Travel: ["trav1", "trav2"] },
  topics: [],
  itemProvenance: new Map(),
  write: { into: "subcategoryOf", parent: "Library" },  // isFilterMode = false
  allowDiscovery: true,
};

// ── LLM mock helpers ──────────────────────────────────────────

type MockResp = {
  status: number;
  headers: Record<string, string>;
  json: { response: string };
  text: string;
  arrayBuffer: ArrayBuffer;
};

function resp(s: string): MockResp {
  return { status: 200, headers: {}, json: { response: s }, text: s, arrayBuffer: new ArrayBuffer(0) };
}

/**
 * Is this a T2 JSON prompt?
 * T2 prompts start with "Score how well this short video..."
 */
function isT2JsonPrompt(prompt: string): boolean {
  return prompt.startsWith("Score how well");
}

/**
 * Is this a description generation prompt?
 * These contain "collection called" (from generateClusterDescriptions).
 */
function isDescriptionPrompt(prompt: string): boolean {
  return prompt.includes("collection called");
}

/**
 * Does the prompt contain a fitness item summary?
 * We key off unique substrings from fit1-fit5 summaries that appear in the
 * LLM prompt's "Video summary:" section.
 */
function isFitnessPrompt(prompt: string): boolean {
  return (
    prompt.includes("HIIT workout") ||
    prompt.includes("10 minute abs") ||
    prompt.includes("yoga flow") ||
    prompt.includes("strength training guide") ||
    prompt.includes("running tips")
  );
}

/**
 * Install the standard LLM mock:
 * - Description generation: returns "DESCRIPTION: a description\nNOT: nothing"
 * - Fitness items: T1 returns "A", T2 returns '{"B": 9}' → they DISAGREE
 *   With oneHot(2) vs Cooking/Travel centroids, pickedSim ≈ 0 < 0.87 → conditionalReject → unmatched
 * - All other items (t_cook, t_trav): T1 and T2 both return "A" → agree → unconditionally accepted
 *   at their top-similarity candidate (which is their respective correct collection)
 */
function installStandardMock() {
  __setRequestUrlImpl(async (req) => {
    const body = req.body ? JSON.parse(req.body) : {};
    const prompt: string = body.prompt || "";

    if (isDescriptionPrompt(prompt)) {
      return resp("DESCRIPTION: a description\nNOT: nothing");
    }

    // Fitness items: force disagreement between T1 and T2
    if (isFitnessPrompt(prompt)) {
      if (isT2JsonPrompt(prompt)) {
        // T2 picks "B" — T1 picks "A" → disagree → with low sim → conditionalReject → unmatched
        return resp('{"B": 9, "A": 1}');
      }
      // T1 picks "A"
      return resp("A");
    }

    // All other items (t_cook, t_trav): T1 and T2 both agree on "A"
    // → decisionKind = "agree" → conditionalReject = false → always accepted
    if (isT2JsonPrompt(prompt)) {
      return resp('{"A": 9, "B": 1}');
    }
    return resp("A");
  });
}

// ── Host factory ──────────────────────────────────────────────

type Spies = {
  proposal: ClassifyProposalData | null;
  vaultCollections: Record<string, string[]> | null;
  matched: Record<string, string[]> | null;
  unsortedIds: Set<string> | null;
  matchDetails: Map<string, unknown> | null;
  steps: (number | null)[];
  appliedFilter: Record<string, unknown> | null;
  loaded: ClassifyProposalData | null;
  newClusterDescs: Map<string, string> | null;
  newClusterNotDescs: Map<string, string> | null;
  mode: string | null;
};

function makeHost(opts: {
  vault: ReturnType<typeof mkVault>;
  input: SmartAssignInput;
  userTopics?: string[];
}): { host: SmartAssignClusteringHost; spies: Spies } {
  const { vault, input, userTopics = [] } = opts;
  const app = mkApp(vault);

  const spies: Spies = {
    proposal: null,
    vaultCollections: null,
    matched: null,
    unsortedIds: null,
    matchDetails: null,
    steps: [],
    appliedFilter: null,
    loaded: null,
    newClusterDescs: null,
    newClusterNotDescs: null,
    mode: null,
  };

  const plugin = {
    activeEmbedder: null as Embedder | null,
    createEmbedder: vi.fn(async () => new TestEmbedder()),
    settings: {
      embeddingBackend: "ollama",
      syncFolder: "Bookmarks",
      clipFusionAlpha: 0,          // text-only fusion → simplest geometry
      integrations: { ffmpeg: false },
    },
  } as unknown as import("@/types/plugin").IRoostPlugin;

  const refs = {
    platformRef: { current: undefined } as unknown as import("react").MutableRefObject<string | undefined>,
    inputRef: { current: input } as unknown as import("react").MutableRefObject<SmartAssignInput | null>,
    stopSignalRef: { current: null } as unknown as import("react").MutableRefObject<StopSignal | null>,
    descCachePathRef: { current: null } as unknown as import("react").MutableRefObject<string | null>,
    notDescCachePathRef: { current: null } as unknown as import("react").MutableRefObject<string | null>,
    catEmbeddingsRef: { current: null } as unknown as import("react").MutableRefObject<unknown>,
    taxonomyRef: { current: null } as unknown as import("react").MutableRefObject<unknown>,
  };

  const host: SmartAssignClusteringHost = {
    app,
    plugin,
    log: () => {},
    applyFilter: vi.fn((f) => { spies.appliedFilter = f as Record<string, unknown>; }),
    setSyncProgress: vi.fn(),
    getUserTopics: () => userTopics,
    getInput: () => input,
    refs: refs as SmartAssignClusteringHost["refs"],
    setMode: vi.fn((m) => { spies.mode = m; }),
    setPipelineStep: vi.fn((n) => { spies.steps.push(n); }),
    setUnsortedIds: vi.fn((s) => { spies.unsortedIds = s; }),
    setMatchedToCollections: vi.fn((m) => { spies.matched = m; }),
    setMatchDetailMap: vi.fn((m) => { spies.matchDetails = m; }),
    setVaultCollections: vi.fn((c) => { spies.vaultCollections = c; }),
    setProposal: vi.fn((p) => { spies.proposal = p; }),
    setNewClusterDescriptions: vi.fn((m) => { spies.newClusterDescs = m; }),
    setNewClusterNotDescriptions: vi.fn((m) => { spies.newClusterNotDescs = m; }),
    setAssignedSubcategories: vi.fn() as SmartAssignClusteringHost["setAssignedSubcategories"],
    setForceToggle: vi.fn(),
    setUserRenames: vi.fn(),
    loadFromClusterOutput: vi.fn((r) => { spies.loaded = r; }),
  };

  return { host, spies };
}

// ── Tests ─────────────────────────────────────────────────────

describe("clustering integration (steps 0→1→2)", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roost-clu-"));
    __resetEmbeddingCache();
    __resetScoreCacheForTests();
  });

  afterEach(() => {
    __resetRequestUrlImpl();
    __resetEmbeddingCache();
    __resetScoreCacheForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Test 1: Full orchestrator happy path ───────────────────
  it("routes known items, discovers a new Fitness category, and emits a well-formed proposal", async () => {
    const vault = mkVault();
    saveEmbeddingCache(vault, seedCache());
    const input: SmartAssignInput = { ...TEST_INPUT, allowDiscovery: true };
    const { host, spies } = makeHost({ vault, input });

    installStandardMock();
    await runSmartAssignClustering(host);

    // 1. Pipeline progressed through steps 0, 1, 2, and reached step 5
    expect(spies.steps).toContain(0);
    expect(spies.steps).toContain(1);
    expect(spies.steps).toContain(2);
    expect(spies.steps[spies.steps.length - 1]).toBe(5);

    // 2. Phase-1 routing: t_cook → Cooking, t_trav → Travel; no fit* items there
    const matched = spies.matched!;
    expect(matched).toBeDefined();
    expect(matched["Cooking"]).toBeDefined();
    expect(matched["Cooking"]).toContain("t_cook");
    expect(matched["Travel"]).toBeDefined();
    expect(matched["Travel"]).toContain("t_trav");
    // fit* items must NOT appear in any known collection match
    const allMatchedIds = Object.values(matched).flat();
    for (const fitId of ["fit1", "fit2", "fit3", "fit4", "fit5"]) {
      expect(allMatchedIds).not.toContain(fitId);
    }

    // 3. Collections mutated: Cooking includes anchors + t_cook
    const vaultColls = spies.vaultCollections!;
    expect(vaultColls).toBeDefined();
    expect(vaultColls["Cooking"]).toContain("cook1");
    expect(vaultColls["Cooking"]).toContain("cook2");
    expect(vaultColls["Cooking"]).toContain("t_cook");

    // 4. Discovery: a Fitness proposal was created
    const proposal = spies.proposal as ClassifyProposalData;
    expect(proposal).toBeDefined();
    expect(proposal.proposals.length).toBeGreaterThanOrEqual(1);

    // Find the Fitness proposal
    const fitProposal = proposal.proposals.find(p => p.suggestedName === "Fitness");
    expect(fitProposal).toBeDefined();

    // It must contain all 5 fit* items
    const fitIds = new Set(fitProposal!.itemIds);
    expect(fitIds.has("fit1")).toBe(true);
    expect(fitIds.has("fit2")).toBe(true);
    expect(fitIds.has("fit3")).toBe(true);
    expect(fitIds.has("fit4")).toBe(true);
    expect(fitIds.has("fit5")).toBe(true);

    // 5. Proposal shape contracts
    expect(typeof proposal.platform).toBe("string");
    expect(Array.isArray(proposal.noiseItemIds)).toBe(true);
    // When all fit items are discovered, miscIds should be empty
    expect(proposal.noiseItemIds).toHaveLength(0);
    expect(proposal.collections).toBe(vaultColls);  // same reference

    // Fitness proposal shape
    expect(fitProposal!.source).toBe("cluster");
    expect(fitProposal!.fromCollection).toBe(false);
    expect(fitProposal!.confidence).toBe(0);
    expect(fitProposal!.altNames).toEqual([fitProposal!.suggestedName]);
    expect(fitProposal!.count).toBe(fitProposal!.itemIds.length);
    expect(fitProposal!.samples.length).toBe(Math.min(6, fitProposal!.itemIds.length));
    for (const sample of fitProposal!.samples) {
      expect(typeof sample.id).toBe("string");
      // name and summary may be undefined or string
      if (sample.name !== undefined) expect(typeof sample.name).toBe("string");
    }

    // 6. Step 5 handoff
    expect(host.applyFilter).toHaveBeenCalledOnce();
    const filter = spies.appliedFilter!;
    expect(Array.isArray(filter["folders"])).toBe(true);
    expect((filter["folders"] as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect(host.loadFromClusterOutput).toHaveBeenCalledWith(proposal);
  });

  // ── Test 2: Discovery disabled → unmatched become noise ───
  it("with allowDiscovery=false, unmatched items become noise, no proposals", async () => {
    const vault = mkVault();
    saveEmbeddingCache(vault, seedCache());
    const input: SmartAssignInput = { ...TEST_INPUT, allowDiscovery: false };
    const { host, spies } = makeHost({ vault, input });

    installStandardMock();
    await runSmartAssignClustering(host);

    const proposal = spies.proposal as ClassifyProposalData;
    expect(proposal).toBeDefined();

    // No new category proposals
    expect(proposal.proposals).toEqual([]);

    // All fit* items end up as noise
    for (const fitId of ["fit1", "fit2", "fit3", "fit4", "fit5"]) {
      expect(proposal.noiseItemIds).toContain(fitId);
    }

    // Known routing unchanged
    const matched = spies.matched!;
    expect(matched["Cooking"]).toContain("t_cook");
    expect(matched["Travel"]).toContain("t_trav");
  });

  // ── Test 3: Stacked-heads pass-through on class mismatch (Task 3) ────
  //
  // Before Task 3, clustering-step-1-score.ts nulled stacked heads when
  // stackedHeadsClassesMatch() returned false (live categories not in head's
  // training set). Task 3 removes that kill-switch so the cascade always
  // receives the heads and handles off-taxonomy classes gracefully itself.
  it("passes stacked heads to scoreAgainstCategories even when head classes mismatch live categories", async () => {
    // Arrange: write stacked-head files whose classes ["OldCat1","OldCat2"]
    // are a complete mismatch with the live categories ["Cooking","Travel"].
    const cacheDir = path.join(tmpDir, ".roost", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const mismatchHead = {
      version: 1,
      classes: ["OldCat1", "OldCat2"],
      W: [[1, 0], [0, 1]],
      b: [0, 0],
      dim: 2,
      norm: "l2",
      trainedOn: 5,
    };
    const mismatchMeta = {
      version: 1,
      classes: ["OldCat1", "OldCat2"],
      W: [[5, 0, 5, 0], [0, 5, 0, 5]],
      b: [0, 0],
      inDim: 4,
      norm: "none",
    };
    fs.writeFileSync(path.join(cacheDir, "classifier-head-text.json"), JSON.stringify(mismatchHead));
    fs.writeFileSync(path.join(cacheDir, "classifier-head-vision.json"), JSON.stringify(mismatchHead));
    fs.writeFileSync(path.join(cacheDir, "meta-head.json"), JSON.stringify(mismatchMeta));

    const vault = mkVault();
    saveEmbeddingCache(vault, seedCache());
    const input: SmartAssignInput = { ...TEST_INPUT };
    const { host } = makeHost({ vault, input });

    // Enable all three flags needed for the stacked-head path.
    const s = host.plugin.settings as unknown as Record<string, unknown>;
    s["smartAssignClassifierHead"] = true;
    s["smartAssignEmbeddingOnly"] = true;
    s["smartAssignStacking"] = true;

    // Capture log messages.
    const logs: string[] = [];
    (host as unknown as Record<string, unknown>)["log"] = (msg: string) => { logs.push(msg); };

    installStandardMock();

    const signal: StopSignal = { stopped: false, stop() { this.stopped = true; } };
    host.refs.stopSignalRef.current = signal;

    const s0 = await runClusteringStep0Embed(host, signal);
    expect(s0).not.toBeNull();
    await runClusteringStep1ScoreKnown(host, signal, s0!);

    // The kill-switch MUST be gone: no warning about class mismatch.
    const allLogs = logs.join("\n");
    expect(allLogs).not.toMatch(/don't match current collections/);
    // Instead the info log confirms the heads were passed through to the cascade.
    expect(allLogs).toMatch(/Stacked heads loaded.*cascade will use/);
  });

  // ── Test 4: Step-by-step slice wiring (white-box) ─────────
  it("step 0→1→2 slices compose correctly and expose the expected contracts", async () => {
    const vault = mkVault();
    saveEmbeddingCache(vault, seedCache());
    const input: SmartAssignInput = { ...TEST_INPUT, allowDiscovery: true };
    const { host, spies } = makeHost({ vault, input });

    installStandardMock();

    // Set up stop signal manually (the orchestrator does this)
    const signal: StopSignal = { stopped: false, stop() { this.stopped = true; } };
    host.refs.stopSignalRef.current = signal;

    // Step 0
    const s0 = await runClusteringStep0Embed(host, signal);
    expect(s0).not.toBeNull();

    // All 7 target items have vecs → should appear in unsortedItemIds
    expect(s0!.unsortedItemIds.length).toBe(7);
    for (const id of ["t_cook", "t_trav", "fit1", "fit2", "fit3", "fit4", "fit5"]) {
      expect(s0!.unsortedItemIds).toContain(id);
    }
    // Anchor ids are NOT in unsortedItemIds (they are in collections)
    for (const id of ["cook1", "cook2", "trav1", "trav2"]) {
      expect(s0!.unsortedItemIds).not.toContain(id);
    }

    // Step 1
    const s1 = await runClusteringStep1ScoreKnown(host, signal, s0!);
    expect(s1).not.toBeNull();

    // isFilterMode = false (write.into = "subcategoryOf")
    expect(s1!.isFilterMode).toBe(false);

    // t_cook → Cooking, t_trav → Travel
    expect(s1!.phase1Assignments.get("t_cook")).toBe("Cooking");
    expect(s1!.phase1Assignments.get("t_trav")).toBe("Travel");

    // fit* items are unmatched
    for (const fitId of ["fit1", "fit2", "fit3", "fit4", "fit5"]) {
      expect(s1!.phase1Unmatched).toContain(fitId);
    }
    // 5 items unmatched
    expect(s1!.phase1Unmatched.length).toBe(5);

    // Step 2
    const s2 = await runClusteringStep2DiscoverAndScore(host, signal, { ...s0!, ...s1! });
    expect(s2).not.toBeNull();

    // Result should match what setProposal captured
    expect(s2!.result).toEqual(spies.proposal);

    // All fit* items discovered — nothing in misc
    expect(s2!.miscIds).toHaveLength(0);

    // The proposal has at least one entry (Fitness)
    expect(s2!.result.proposals.length).toBeGreaterThanOrEqual(1);
    const fitProposal = s2!.result.proposals.find(p => p.suggestedName === "Fitness");
    expect(fitProposal).toBeDefined();
    expect(fitProposal!.itemIds.length).toBe(5);
  });
});
