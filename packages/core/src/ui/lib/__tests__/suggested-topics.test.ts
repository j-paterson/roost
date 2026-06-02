import { describe, it, expect } from "vitest";
import { aggregateSuggestedTopics } from "../suggested-topics";
import type { EmbeddingCacheEntry } from "@/types/roost";

function entry(category: string | null): EmbeddingCacheEntry {
  return { vision: null, summary: null, category, vec: null };
}

describe("aggregateSuggestedTopics", () => {
  it("aggregates counts from item categories, sorted by count desc", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      a: entry("Music"), b: entry("Music"), c: entry("Music"),
      d: entry("Anime"), e: entry("Anime"),
      f: entry("Gaming"),
    };
    const out = aggregateSuggestedTopics(["a", "b", "c", "d", "e", "f"], cache, {
      minCount: 1, topN: 10, existingTopics: [],
    });
    expect(out).toEqual([
      { name: "Music", count: 3 },
      { name: "Anime", count: 2 },
      { name: "Gaming", count: 1 },
    ]);
  });

  it("strips trailing punctuation", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      a: entry("Music."), b: entry("Music"), c: entry("Music."),
    };
    const out = aggregateSuggestedTopics(["a", "b", "c"], cache, {
      minCount: 1, topN: 10, existingTopics: [],
    });
    expect(out).toEqual([{ name: "Music", count: 3 }]);
  });

  it("dedupes case-insensitively, preserves most-common casing", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      a: entry("Music"), b: entry("Music"), c: entry("music"),
    };
    const out = aggregateSuggestedTopics(["a", "b", "c"], cache, {
      minCount: 1, topN: 10, existingTopics: [],
    });
    expect(out).toEqual([{ name: "Music", count: 3 }]);
  });

  it("filters entries below minCount", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      a: entry("Music"), b: entry("Music"),
      c: entry("Anime"),
    };
    const out = aggregateSuggestedTopics(["a", "b", "c"], cache, {
      minCount: 2, topN: 10, existingTopics: [],
    });
    expect(out).toEqual([{ name: "Music", count: 2 }]);
  });

  it("excludes names that match existingTopics (case-insensitive)", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      a: entry("Music"), b: entry("Music"),
      c: entry("Anime"), d: entry("Anime"),
    };
    const out = aggregateSuggestedTopics(["a", "b", "c", "d"], cache, {
      minCount: 1, topN: 10, existingTopics: ["MUSIC"],
    });
    expect(out).toEqual([{ name: "Anime", count: 2 }]);
  });

  it("skips items whose cache entry is missing or has null category", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      a: entry("Music"),
      b: entry(null),
      // c is intentionally missing from cache
    };
    const out = aggregateSuggestedTopics(["a", "b", "c"], cache, {
      minCount: 1, topN: 10, existingTopics: [],
    });
    expect(out).toEqual([{ name: "Music", count: 1 }]);
  });

  it("trims whitespace before aggregation", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      a: entry("  Music "), b: entry("Music"), c: entry("Music  "),
    };
    const out = aggregateSuggestedTopics(["a", "b", "c"], cache, {
      minCount: 1, topN: 10, existingTopics: [],
    });
    expect(out).toEqual([{ name: "Music", count: 3 }]);
  });

  it("ignores empty / whitespace-only categories after normalization", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      a: entry(""), b: entry("."), c: entry("   "), d: entry("Music"),
    };
    const out = aggregateSuggestedTopics(["a", "b", "c", "d"], cache, {
      minCount: 1, topN: 10, existingTopics: [],
    });
    expect(out).toEqual([{ name: "Music", count: 1 }]);
  });

  it("caps at topN", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {};
    const ids: string[] = [];
    let id = 0;
    for (let n = 20; n >= 1; n--) {
      const cat = `Cat${n}`;
      for (let i = 0; i < n; i++) {
        const k = `i${id++}`;
        cache[k] = entry(cat);
        ids.push(k);
      }
    }
    const out = aggregateSuggestedTopics(ids, cache, {
      minCount: 1, topN: 5, existingTopics: [],
    });
    expect(out.length).toBe(5);
    expect(out[0]).toEqual({ name: "Cat20", count: 20 });
    expect(out[4]).toEqual({ name: "Cat16", count: 16 });
  });

  it("breaks ties on count by name asc for stable output", () => {
    const cache: Record<string, EmbeddingCacheEntry> = {
      a: entry("Music"), b: entry("Music"),
      c: entry("Anime"), d: entry("Anime"),
      e: entry("Gaming"), f: entry("Gaming"),
    };
    const out = aggregateSuggestedTopics(["a", "b", "c", "d", "e", "f"], cache, {
      minCount: 1, topN: 10, existingTopics: [],
    });
    expect(out).toEqual([
      { name: "Anime", count: 2 },
      { name: "Gaming", count: 2 },
      { name: "Music", count: 2 },
    ]);
  });
});
