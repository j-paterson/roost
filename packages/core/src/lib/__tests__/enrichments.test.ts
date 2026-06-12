// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  ENRICHMENTS,
  getEnrichmentById,
  countFor,
  enrichmentVersionField,
  isVersionStale,
  PIPELINE_ENRICHMENT_IDS,
  type EnrichmentId,
} from "../enrichments";

describe("ENRICHMENTS registry", () => {
  it("registers a unique commandId per enrichment", () => {
    const commandIds = ENRICHMENTS.map(e => e.commandId);
    expect(new Set(commandIds).size).toBe(commandIds.length);
  });

  it("mediaFiles has legacyAliases for the old enrichment_v_media field", () => {
    const def = getEnrichmentById("mediaFiles");
    expect(def?.legacyAliases).toContain("enrichment_v_media");
  });

  it("getEnrichmentById('media') returns undefined post-rename", () => {
    expect(getEnrichmentById("media" as never)).toBeUndefined();
  });

});

describe("getEnrichmentById", () => {
  it("returns the def for a known id", () => {
    const def = getEnrichmentById("articleBody");
    expect(def?.commandId).toBe("backfill-x-articles");
  });

  it("returns undefined for an unknown id", () => {
    expect(getEnrichmentById("rawJson")).toBeUndefined();
    expect(getEnrichmentById("nonsense")).toBeUndefined();
  });
});

describe("countFor", () => {
  function makeByCategory(counts: Partial<Record<EnrichmentId | "rawJson", number>>) {
    const fill = (n: number | undefined) => new Set(Array.from({ length: n ?? 0 }, (_, i) => `id-${i}`));
    return {
      rawJson: fill(counts.rawJson),
      mediaFiles: fill(counts.mediaFiles),
      thread: fill(counts.thread),
      articleBody: fill(counts.articleBody),
      playback: fill(counts.playback),
      tweetBody: fill(counts.tweetBody),
    };
  }

  it("returns 0 when byCategory is null/undefined", () => {
    expect(countFor("articleBody", null)).toBe(0);
    expect(countFor("articleBody", undefined)).toBe(0);
  });

  it("returns the bucket size for the requested id", () => {
    const bc = makeByCategory({ articleBody: 5, thread: 12, mediaFiles: 3 });
    expect(countFor("articleBody", bc)).toBe(5);
    expect(countFor("thread", bc)).toBe(12);
    expect(countFor("mediaFiles", bc)).toBe(3);
  });

  it("returns 0 for an empty bucket", () => {
    const bc = makeByCategory({});
    expect(countFor("thread", bc)).toBe(0);
  });
});

describe("enrichmentVersionField", () => {
  it("derives the per-id frontmatter field name", () => {
    expect(enrichmentVersionField("articleBody")).toBe("enrichment_v_articleBody");
    expect(enrichmentVersionField("thread")).toBe("enrichment_v_thread");
    expect(enrichmentVersionField("mediaFiles")).toBe("enrichment_v_mediaFiles");
  });
});

describe("isVersionStale", () => {
  it("returns false when frontmatter is undefined", () => {
    expect(isVersionStale("articleBody", undefined, 1)).toBe(false);
  });

  it("returns false when the version field is absent (legacy items)", () => {
    expect(isVersionStale("articleBody", { roost_id: "twitter:1" }, 1)).toBe(false);
  });

  it("returns false when the version field equals the current schemaVersion", () => {
    expect(isVersionStale("articleBody", { enrichment_v_articleBody: 1 }, 1)).toBe(false);
  });

  it("returns false when the version field is newer than current (downgrade safety)", () => {
    expect(isVersionStale("articleBody", { enrichment_v_articleBody: 2 }, 1)).toBe(false);
  });

  it("returns true when the version field is older than current schemaVersion", () => {
    expect(isVersionStale("articleBody", { enrichment_v_articleBody: 1 }, 2)).toBe(true);
  });

  it("checks the right field per id", () => {
    const fm = { enrichment_v_thread: 1 };
    expect(isVersionStale("articleBody", fm, 2)).toBe(false); // articleBody field absent
    expect(isVersionStale("thread", fm, 2)).toBe(true); // thread field stale
  });

  it("ignores non-numeric stored values", () => {
    expect(isVersionStale("articleBody", { enrichment_v_articleBody: "1" }, 2)).toBe(false);
    expect(isVersionStale("articleBody", { enrichment_v_articleBody: null }, 2)).toBe(false);
  });
});

describe("isVersionStale with legacyAliases", () => {
  it("returns false when only a legacy alias field is set and version matches", () => {
    const fm = { pipeline_v_media: 2 };
    const result = isVersionStale("mediaFiles", fm, 2, ["pipeline_v_media"]);
    expect(result).toBe(false);
  });

  it("returns true when only a legacy alias field is set and version is older", () => {
    const fm = { pipeline_v_media: 1 };
    const result = isVersionStale("mediaFiles", fm, 2, ["pipeline_v_media"]);
    expect(result).toBe(true);
  });

  it("prefers the canonical field over a legacy alias when both present", () => {
    const fm = { enrichment_v_mediaFiles: 2, pipeline_v_media: 1 };
    const result = isVersionStale("mediaFiles", fm, 2, ["pipeline_v_media"]);
    expect(result).toBe(false);
  });
});

describe("Pipeline enrichments (Phase 2)", () => {
  it("registers all 7 pipeline enrichments", () => {
    const registeredIds = new Set(ENRICHMENTS.map(e => e.id));
    for (const id of PIPELINE_ENRICHMENT_IDS) {
      expect(registeredIds.has(id)).toBe(true);
    }
  });

  it("each pipeline enrichment declares categoryMatches", () => {
    for (const id of PIPELINE_ENRICHMENT_IDS) {
      const def = getEnrichmentById(id);
      expect(def?.categoryMatches?.length).toBeGreaterThan(0);
    }
  });

  it("mediaExtraction has legacyAliases for pipeline_v_media", () => {
    const def = getEnrichmentById("mediaExtraction");
    expect(def?.legacyAliases).toContain("pipeline_v_media");
  });
});
