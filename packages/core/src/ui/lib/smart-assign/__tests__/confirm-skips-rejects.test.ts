import { describe, it, expect } from "vitest";
import { buildItemCategory } from "../confirm";

describe("buildItemCategory", () => {
  const base = {
    proposedFolders: [{ name: "Tech", itemIds: ["a", "b", "c"] }],
    unsortedIds: new Set(["a", "b", "c"]),
    uncertainIds: new Set<string>(),
    reassigned: new Map<string, string>(),
    rejects: new Set<string>(),
    isSubcat: false,
    assignedSubcategories: new Map<string, string | null>(),
  };

  it("includes normal items, encoded with subcat separator", () => {
    const m = buildItemCategory(base);
    expect(m.get("a")).toBe("Tech\x00");
  });

  it("skips a rejected item", () => {
    const m = buildItemCategory({ ...base, rejects: new Set(["b"]) });
    expect(m.has("b")).toBe(false);
    expect(m.has("a")).toBe(true);
  });

  it("still skips uncertain-not-reassigned items", () => {
    const m = buildItemCategory({ ...base, uncertainIds: new Set(["c"]) });
    expect(m.has("c")).toBe(false);
  });
});
