import { describe, it, expect } from "vitest";
import { resortNote } from "../../../../../scripts/apply-taxonomy-resort.mjs";

const ALIASES = { "twitter:web3": "Tech", "tiktok:Stuff": "Products", "tiktok:Recipes": "Food" };

function note(fm: Record<string, unknown>) {
  const body = "---\n" + Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n---\n\nbody text\n";
  return body;
}

describe("resortNote (taxonomy resort mirror of resortPatch)", () => {
  it("FOLD: web3 → Tech / web3, stamps human, preserves other frontmatter", () => {
    const { content, changed, target } = resortNote(
      note({ roost_id: "twitter:1", platform: "twitter", collection: "web3", roost_category: "web3", roost_assigned_by: "auto" }),
      ALIASES,
    );
    expect(changed).toBe(true);
    expect(target).toBe("Tech");
    expect(content).toContain("roost_category: Tech");
    expect(content).toContain("roost_subcategory: web3");
    expect(content).toContain("roost_assigned_by: human");
    expect(content).toContain("roost_id: twitter:1"); // untouched
    expect(content).toContain("\nbody text\n");
  });

  it("IDENTITY + unchanged: keeps a pipeline subcategory, just flips provenance", () => {
    const { content } = resortNote(
      note({ platform: "tiktok", collection: "Food", roost_category: "Food", roost_subcategory: "Recipes", roost_assigned_by: "auto" }),
      ALIASES,
    );
    expect(content).toContain("roost_category: Food");
    expect(content).toContain("roost_subcategory: Recipes"); // preserved
    expect(content).toContain("roost_assigned_by: human");
  });

  it("IDENTITY + moved: clears the orphaned subcategory", () => {
    const { content } = resortNote(
      note({ platform: "tiktok", collection: "Food", roost_category: "OldAuto", roost_subcategory: "Stale", roost_assigned_by: "auto" }),
      ALIASES,
    );
    expect(content).toContain("roost_category: Food");
    expect(content).not.toContain("roost_subcategory");
  });

  it("already correct (incl. folded subcat): no change", () => {
    const src = note({ platform: "twitter", collection: "web3", roost_category: "Tech", roost_subcategory: "web3", roost_assigned_by: "human" });
    const { changed, content } = resortNote(src, ALIASES);
    expect(changed).toBe(false);
    expect(content).toBe(src);
  });

  it("no collection → no change", () => {
    const src = note({ platform: "tiktok", roost_category: "X" });
    expect(resortNote(src, ALIASES).changed).toBe(false);
  });

  it("quotes a category value containing YAML-special chars", () => {
    const { content } = resortNote(
      note({ platform: "tiktok", collection: "Places", roost_category: "Places" }),
      { "tiktok:Places": "Places & Travel" },
    );
    expect(content).toContain('roost_category: "Places & Travel"');
    expect(content).toContain("roost_subcategory: Places");
  });
});
