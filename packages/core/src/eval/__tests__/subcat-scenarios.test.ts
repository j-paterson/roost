import { describe, it, expect } from "vitest";
import { buildScenarios, type VaultItem, type BuildScenariosOpts } from "@/eval/subcat-scenarios";

const DEFAULTS: BuildScenariosOpts = {
  minSubcats: 2,
  minItemsPerSubcat: 10,
  maxNegativesPerParent: 1000,
};

describe("buildScenarios", () => {
  it("returns an empty scenarios JSON when no items have subcategories", () => {
    const items: VaultItem[] = [
      { itemId: "a", category: "Recipes", subcategory: null },
      { itemId: "b", category: "Recipes", subcategory: null },
    ];
    const out = buildScenarios(items, DEFAULTS);
    expect(out.parents).toEqual([]);
    expect(out.stats.parentsIncluded).toBe(0);
    expect(out.stats.totalPositives).toBe(0);
    expect(out.stats.totalNegatives).toBe(0);
  });

  function makeItems(parent: string, subcatCounts: Record<string, number>): VaultItem[] {
    const out: VaultItem[] = [];
    let n = 0;
    for (const [subcat, count] of Object.entries(subcatCounts)) {
      for (let i = 0; i < count; i++) {
        out.push({ itemId: `${parent}-${subcat}-${n++}`, category: parent, subcategory: subcat });
      }
    }
    return out;
  }

  it("excludes parents with fewer than minSubcats qualifying subcategories", () => {
    // Recipes has only 1 subcategory with ≥ 10 items → excluded.
    const items = makeItems("Recipes", { Italian: 12, French: 3 });
    const out = buildScenarios(items, DEFAULTS);
    expect(out.parents).toHaveLength(0);
  });

  it("excludes subcategories below minItemsPerSubcat from the count", () => {
    // 3 subcats, but only 2 have ≥ 10 items → still passes (minSubcats=2).
    const items = makeItems("Recipes", { Italian: 12, French: 11, Greek: 4 });
    const out = buildScenarios(items, DEFAULTS);
    expect(out.parents).toHaveLength(1);
    expect(out.parents[0].subcategories).toEqual(["French", "Italian"]);
  });

  it("includes a parent when ≥ minSubcats subcategories meet minItemsPerSubcat", () => {
    const items = makeItems("Recipes", { Italian: 12, French: 11 });
    const out = buildScenarios(items, DEFAULTS);
    expect(out.parents).toHaveLength(1);
    expect(out.parents[0].parent).toBe("Recipes");
    expect(out.stats.parentsIncluded).toBe(1);
  });

  it("excludes positives whose subcategory was dropped for low item count", () => {
    // Greek has only 4 items — filtered out — so its 4 items must not appear
    // in the positives list, even though they have a subcategory set.
    const items = makeItems("Recipes", { Italian: 12, French: 11, Greek: 4 });
    const out = buildScenarios(items, DEFAULTS);
    const ids = out.parents[0].positives.map(p => p.itemId);
    expect(ids.some(id => id.startsWith("Recipes-Greek-"))).toBe(false);
    expect(out.stats.totalPositives).toBe(23); // 12 + 11
  });

  it("collects negatives from items with category but no subcategory", () => {
    const items: VaultItem[] = [
      ...makeItems("Recipes", { Italian: 12, French: 11 }),
      { itemId: "n1", category: "Recipes", subcategory: null },
      { itemId: "n2", category: "Recipes", subcategory: null },
    ];
    const out = buildScenarios(items, DEFAULTS);
    expect(out.parents[0].negatives.map(n => n.itemId).sort()).toEqual(["n1", "n2"]);
    expect(out.stats.totalNegatives).toBe(2);
  });

  it("caps negatives per parent at maxNegativesPerParent", () => {
    const items: VaultItem[] = [
      ...makeItems("Recipes", { Italian: 12, French: 11 }),
      ...Array.from({ length: 50 }, (_, i) => ({
        itemId: `n${i}`, category: "Recipes", subcategory: null,
      })),
    ];
    const out = buildScenarios(items, { ...DEFAULTS, maxNegativesPerParent: 5 });
    expect(out.parents[0].negatives).toHaveLength(5);
    expect(out.stats.totalNegatives).toBe(5);
  });

  it("further caps negatives at the parent's positive count", () => {
    // Parent has 23 positives but maxNegativesPerParent=100 — capped at 23.
    const items: VaultItem[] = [
      ...makeItems("Recipes", { Italian: 12, French: 11 }),
      ...Array.from({ length: 50 }, (_, i) => ({
        itemId: `n${i}`, category: "Recipes", subcategory: null,
      })),
    ];
    const out = buildScenarios(items, { ...DEFAULTS, maxNegativesPerParent: 100 });
    expect(out.parents[0].negatives).toHaveLength(23);
    expect(out.stats.totalNegatives).toBe(23);
  });

  it("ignores negatives for parents that didn't qualify", () => {
    const items: VaultItem[] = [
      // Only 1 qualifying subcat → parent excluded.
      ...makeItems("Recipes", { Italian: 12 }),
      { itemId: "n1", category: "Recipes", subcategory: null },
    ];
    const out = buildScenarios(items, DEFAULTS);
    expect(out.parents).toHaveLength(0);
    expect(out.stats.totalNegatives).toBe(0);
  });

  it("computes parentCentroid as the mean of positives' vectors", () => {
    const items: VaultItem[] = [
      ...Array.from({ length: 10 }, (_, i) => ({
        itemId: `it${i}`, category: "Recipes", subcategory: "Italian",
        vec: [1, 0, 0],
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        itemId: `fr${i}`, category: "Recipes", subcategory: "French",
        vec: [0, 1, 0],
      })),
    ];
    const out = buildScenarios(items, DEFAULTS);
    expect(out.parents).toHaveLength(1);
    const c = out.parents[0].parentCentroid!;
    // Mean of (1,0,0) × 10 and (0,1,0) × 10 = (0.5, 0.5, 0)
    expect(c[0]).toBeCloseTo(0.5, 5);
    expect(c[1]).toBeCloseTo(0.5, 5);
    expect(c[2]).toBeCloseTo(0.0, 5);
  });

  it("returns parentCentroid=null when no positives have embeddings", () => {
    const items: VaultItem[] = [
      ...Array.from({ length: 10 }, (_, i) => ({
        itemId: `it${i}`, category: "Recipes", subcategory: "Italian",
        // no vec
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        itemId: `fr${i}`, category: "Recipes", subcategory: "French",
        // no vec
      })),
    ];
    const out = buildScenarios(items, DEFAULTS);
    expect(out.parents[0].parentCentroid).toBe(null);
  });

  it("ignores items without vectors when computing the centroid", () => {
    const items: VaultItem[] = [
      ...Array.from({ length: 10 }, (_, i) => ({
        itemId: `it${i}`, category: "Recipes", subcategory: "Italian",
        vec: i < 5 ? [1, 0, 0] : undefined, // half have vecs
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        itemId: `fr${i}`, category: "Recipes", subcategory: "French",
        vec: [0, 1, 0],
      })),
    ];
    const out = buildScenarios(items, DEFAULTS);
    const c = out.parents[0].parentCentroid!;
    // 5 Italian (1,0,0) + 10 French (0,1,0) ÷ 15 = (5/15, 10/15, 0)
    expect(c[0]).toBeCloseTo(5 / 15, 5);
    expect(c[1]).toBeCloseTo(10 / 15, 5);
    expect(c[2]).toBeCloseTo(0, 5);
  });
});
