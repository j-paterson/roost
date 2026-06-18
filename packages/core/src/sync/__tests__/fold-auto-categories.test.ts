import { describe, it, expect } from "vitest";
import { foldNote } from "../../../../../scripts/fold-auto-categories.mjs";

const MAP = { "code": "Tech", "Psychology": "Growth", "D & D": "Other" };
function note(fm: Record<string, unknown>) {
  return "---\n" + Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n---\n\nbody\n";
}

describe("foldNote", () => {
  it("folds a fragment category into its top-level, keeping the fragment as subcategory", () => {
    const { content, changed, target } = foldNote(note({ roost_id: "x:1", roost_category: "code", roost_assigned_by: "auto" }), MAP);
    expect(changed).toBe(true);
    expect(target).toBe("Tech");
    expect(content).toContain("roost_category: Tech");
    expect(content).toContain("roost_subcategory: code");
    expect(content).toContain("roost_assigned_by: auto"); // provenance untouched
    expect(content).toContain("roost_id: x:1");
  });

  it("overwrites an existing deeper subcategory with the fragment", () => {
    const { content } = foldNote(note({ roost_category: "Psychology", roost_subcategory: "Cognition" }), MAP);
    expect(content).toContain("roost_category: Growth");
    expect(content).toContain("roost_subcategory: Psychology");
    expect(content).not.toContain("Cognition");
  });

  it("quotes a fragment with YAML-special chars when used as subcategory", () => {
    const { content } = foldNote(note({ roost_category: "D & D" }), MAP);
    expect(content).toContain("roost_category: Other");
    expect(content).toContain('roost_subcategory: "D & D"');
  });

  it("no-op when roost_category is already a top-level (not a fragment)", () => {
    const src = note({ roost_category: "Tech", roost_subcategory: "web3" });
    expect(foldNote(src, MAP)).toMatchObject({ changed: false });
    expect(foldNote(src, MAP).content).toBe(src);
  });

  it("no-op when there is no roost_category", () => {
    expect(foldNote(note({ roost_id: "x:2" }), MAP).changed).toBe(false);
  });
});
