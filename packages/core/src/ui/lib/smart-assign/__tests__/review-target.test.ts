// @vitest-environment node
/**
 * TDD tests for gatherReviewTargets (Task 6).
 *
 * Synthetic app with:
 *   NC_ITEM  — no roost_category (unsorted pool)
 *   OT_ITEM  — roost_category: "Other"
 *
 * Stub head: 2 classes (Tech, Food), dim=2.
 *   W[Tech] = [1,0], W[Food] = [-1,0], b=[0,0].
 *
 * Resulting confidences:
 *   NC_ITEM  vec=[2,0] → norm [1,0] → z=[1,-1]         → Tech, conf≈0.881
 *   OT_ITEM  vec=[1,1] → norm [.707,.707] → z=[.707,-.707] → Tech, conf≈0.804
 *
 * Ascending-confidence order (least confident first): OT_ITEM, NC_ITEM.
 */
import { describe, it, expect } from "vitest";
import { TFile } from "obsidian";
import type { App } from "obsidian";
import type { ClassifierHead } from "@/pipeline/classifier-head";
import type { EmbeddingCacheEntry } from "@/types/roost";
import { gatherReviewTargets } from "@/ui/lib/smart-assign/review-target";

// ── Stub head ─────────────────────────────────────────────────────────────────

const STUB_HEAD: ClassifierHead = {
  classes: ["Tech", "Food"],
  W: [
    [1, 0],   // Tech: positively aligned to dim 0
    [-1, 0],  // Food: negatively aligned to dim 0
  ],
  b: [0, 0],
  dim: 2,
};

// ── Item fixtures ─────────────────────────────────────────────────────────────

const SYNC_FOLDER = "Bookmarks";

type StubItem = {
  id: string;
  frontmatter?: Record<string, unknown>;
  vec: number[] | null;
};

const NC_ITEM: StubItem = {
  id: "tiktok:nc1",
  frontmatter: { roost_id: "tiktok:nc1" },
  vec: [2, 0],
};

const OT_ITEM: StubItem = {
  id: "tiktok:ot1",
  frontmatter: { roost_id: "tiktok:ot1", roost_category: "Other" },
  vec: [1, 1],
};

// Human-assigned Other — a human already decided; must NOT be gathered.
const HU_OT_ITEM: StubItem = {
  id: "tiktok:hu_ot1",
  frontmatter: { roost_id: "tiktok:hu_ot1", roost_category: "Other", roost_assigned_by: "human" },
  vec: [1, 1],
};

// Auto-assigned Other — not human-judged; must still be gathered.
const AU_OT_ITEM: StubItem = {
  id: "tiktok:au_ot1",
  frontmatter: { roost_id: "tiktok:au_ot1", roost_category: "Other", roost_assigned_by: "auto" },
  vec: [1, 1],
};

/**
 * Head where "Other" is the top class for dim-0-aligned vectors.
 * classes: ["Other", "Tech", "Food"]
 *   W[Other] = [1,0]  → for vec [2,0] (norm [1,0]): z_Other=1
 *   W[Tech]  = [0,1]  → z_Tech=0
 *   W[Food]  = [-1,0] → z_Food=-1
 * softmax([1,0,-1]) ≈ [0.665, 0.245, 0.090]
 * argmax = "Other"; best non-reserved = "Tech" (0.245)
 */
const RESERVED_HEAD: ClassifierHead = {
  classes: ["Other", "Tech", "Food"],
  W: [
    [1, 0],   // Other: aligned with dim 0
    [0, 1],   // Tech: aligned with dim 1
    [-1, 0],  // Food: negatively aligned to dim 0
  ],
  b: [0, 0, 0],
  dim: 2,
};

// ── Factory helpers ───────────────────────────────────────────────────────────

function makeApp(items: StubItem[]): App {
  const fileEntries = items.map(item => ({
    path: `${SYNC_FOLDER}/TikTok/${item.id.replace(":", "-")}/note.md`,
    frontmatter: item.frontmatter ?? {},
  }));

  const vault = {
    getMarkdownFiles: () =>
      fileEntries.map(f => Object.assign(new TFile(), { path: f.path })),
  };

  const metadataCache = {
    getFileCache: (file: { path: string }) => {
      const entry = fileEntries.find(f => f.path === file.path);
      return entry ? { frontmatter: entry.frontmatter } : null;
    },
  };

  return { vault, metadataCache } as unknown as App;
}

function makeCache(items: StubItem[]): Record<string, EmbeddingCacheEntry> {
  const cache: Record<string, EmbeddingCacheEntry> = {};
  for (const item of items) {
    if (item.vec !== null) {
      cache[item.id] = {
        vision: null,
        summary: null,
        category: null,
        vec: item.vec,
        vecText: null,
      };
    }
  }
  return cache;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("gatherReviewTargets", () => {
  const ALL_ITEMS = [NC_ITEM, OT_ITEM];
  const app = makeApp(ALL_ITEMS);
  const cache = makeCache(ALL_ITEMS);

  describe('target: "other"', () => {
    it("returns only the Other item", () => {
      const { ids } = gatherReviewTargets(app, SYNC_FOLDER, "other", cache, STUB_HEAD);
      expect(ids).toEqual(["tiktok:ot1"]);
    });

    it("sets a real-category proposal for the Other item", () => {
      const { proposalMap } = gatherReviewTargets(app, SYNC_FOLDER, "other", cache, STUB_HEAD);
      expect(proposalMap["tiktok:ot1"]).toBe("Tech");
    });

    it("excludes the unsorted (no-category) item", () => {
      const { ids } = gatherReviewTargets(app, SYNC_FOLDER, "other", cache, STUB_HEAD);
      expect(ids).not.toContain("tiktok:nc1");
    });
  });

  describe('target: "unsorted"', () => {
    it("returns only the no-category item", () => {
      const { ids } = gatherReviewTargets(app, SYNC_FOLDER, "unsorted", cache, STUB_HEAD);
      expect(ids).toEqual(["tiktok:nc1"]);
    });

    it("sets a real-category proposal", () => {
      const { proposalMap } = gatherReviewTargets(app, SYNC_FOLDER, "unsorted", cache, STUB_HEAD);
      expect(proposalMap["tiktok:nc1"]).toBe("Tech");
    });

    it("excludes Other items", () => {
      const { ids } = gatherReviewTargets(app, SYNC_FOLDER, "unsorted", cache, STUB_HEAD);
      expect(ids).not.toContain("tiktok:ot1");
    });
  });

  describe('target: "both"', () => {
    it("returns both items", () => {
      const { ids } = gatherReviewTargets(app, SYNC_FOLDER, "both", cache, STUB_HEAD);
      expect(ids).toHaveLength(2);
      expect(ids).toContain("tiktok:nc1");
      expect(ids).toContain("tiktok:ot1");
    });

    it("ranks ascending by confidence: OT_ITEM (≈0.804) before NC_ITEM (≈0.881)", () => {
      const { ids } = gatherReviewTargets(app, SYNC_FOLDER, "both", cache, STUB_HEAD);
      expect(ids[0]).toBe("tiktok:ot1"); // less confident → reviewed first
      expect(ids[1]).toBe("tiktok:nc1"); // more confident → reviewed second
    });

    it("populates proposalMap for both items", () => {
      const { proposalMap } = gatherReviewTargets(app, SYNC_FOLDER, "both", cache, STUB_HEAD);
      expect(proposalMap["tiktok:ot1"]).toBe("Tech");
      expect(proposalMap["tiktok:nc1"]).toBe("Tech");
    });
  });

  describe("head = null", () => {
    it("still returns ids (degraded mode)", () => {
      const { ids } = gatherReviewTargets(app, SYNC_FOLDER, "both", cache, null);
      expect(ids).toHaveLength(2);
      expect(ids).toContain("tiktok:nc1");
      expect(ids).toContain("tiktok:ot1");
    });

    it("returns empty proposalMap when head is null", () => {
      const { proposalMap } = gatherReviewTargets(app, SYNC_FOLDER, "both", cache, null);
      expect(proposalMap).toEqual({});
    });
  });

  describe("vec requirement", () => {
    it("excludes items that have no cached vec", () => {
      const sparseCache = makeCache([NC_ITEM]); // OT_ITEM has no entry → no vec
      const { ids } = gatherReviewTargets(app, SYNC_FOLDER, "other", sparseCache, STUB_HEAD);
      expect(ids).toHaveLength(0);
    });
  });

  describe("human-judged Other exclusion", () => {
    it("does not gather a human-assigned Other item (already judged)", () => {
      const huApp = makeApp([HU_OT_ITEM]);
      const huCache = makeCache([HU_OT_ITEM]);
      const { ids } = gatherReviewTargets(huApp, SYNC_FOLDER, "other", huCache, STUB_HEAD);
      expect(ids).not.toContain("tiktok:hu_ot1");
      expect(ids).toHaveLength(0);
    });

    it("gathers an auto-assigned Other item (not human-judged)", () => {
      const auApp = makeApp([AU_OT_ITEM]);
      const auCache = makeCache([AU_OT_ITEM]);
      const { ids } = gatherReviewTargets(auApp, SYNC_FOLDER, "other", auCache, STUB_HEAD);
      expect(ids).toContain("tiktok:au_ot1");
    });

    it("also excludes human-Other from target='both'", () => {
      const mixApp = makeApp([HU_OT_ITEM, NC_ITEM]);
      const mixCache = makeCache([HU_OT_ITEM, NC_ITEM]);
      const { ids } = gatherReviewTargets(mixApp, SYNC_FOLDER, "both", mixCache, STUB_HEAD);
      expect(ids).not.toContain("tiktok:hu_ot1");
      expect(ids).toContain("tiktok:nc1");
    });
  });

  describe("reserved-category proposal skip", () => {
    it("proposes a real (non-reserved) category when head top is 'Other'", () => {
      // RESERVED_HEAD has Other > Tech > Food for vec=[2,0]; must propose "Tech"
      const item: StubItem = {
        id: "tiktok:res1",
        frontmatter: { roost_id: "tiktok:res1", roost_category: "Other" },
        vec: [2, 0],
      };
      const resApp = makeApp([item]);
      const resCache = makeCache([item]);
      const { proposalMap } = gatherReviewTargets(resApp, SYNC_FOLDER, "other", resCache, RESERVED_HEAD);
      expect(proposalMap["tiktok:res1"]).toBeDefined();
      expect(proposalMap["tiktok:res1"]?.toLowerCase()).not.toBe("other");
      expect(proposalMap["tiktok:res1"]).toBe("Tech");
    });
  });
});
