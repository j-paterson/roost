import { describe, it, expect } from "vitest";
import { stripOrphanedSubcategory } from "../../../../../scripts/strip-orphaned-subcategory.mjs";

const RESORTED = `---\nroost_id: tiktok:1\nplatform: tiktok\ncollection: Finance Tips\nroost_category: Finances\nroost_subcategory: Web_Development\nroost_assigned_by: human\n---\n\nbody\n`;

describe("stripOrphanedSubcategory (scope-A resort cleanup)", () => {
  it("strips roost_subcategory from a resorted note (collection + human)", () => {
    const { content, changed } = stripOrphanedSubcategory(RESORTED);
    expect(changed).toBe(true);
    expect(content).toBe(`---\nroost_id: tiktok:1\nplatform: tiktok\ncollection: Finance Tips\nroost_category: Finances\nroost_assigned_by: human\n---\n\nbody\n`);
  });

  it("no-op when there is no subcategory", () => {
    const clean = `---\ncollection: X\nroost_assigned_by: human\n---\n\nbody\n`;
    expect(stripOrphanedSubcategory(clean).changed).toBe(false);
  });

  it("no-op when not human-assigned (auto note, not resorted)", () => {
    const auto = `---\ncollection: X\nroost_subcategory: Music\nroost_assigned_by: auto\n---\n\nbody\n`;
    expect(stripOrphanedSubcategory(auto).changed).toBe(false);
  });

  it("no-op when there is no collection (e.g. a Smart-Assign human reassignment keeps its subcategory)", () => {
    const noCol = `---\nroost_subcategory: Music\nroost_assigned_by: human\n---\n\nbody\n`;
    expect(stripOrphanedSubcategory(noCol).changed).toBe(false);
  });

  it("no-op on an empty collection value", () => {
    const empty = `---\ncollection: ""\nroost_subcategory: Music\nroost_assigned_by: human\n---\n\nbody\n`;
    expect(stripOrphanedSubcategory(empty).changed).toBe(false);
  });

  it("does not touch a matching string in the body", () => {
    const tricky = `---\ncollection: X\nroost_assigned_by: human\n---\n\nroost_subcategory: Music in prose\n`;
    expect(stripOrphanedSubcategory(tricky).changed).toBe(false);
  });
});
