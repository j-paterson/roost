import { describe, it, expect } from "vitest";
import { showLibraryNav } from "@/ui/lib/show-library-nav";

describe("showLibraryNav", () => {
  it("shows the tree in sync mode regardless of proposal", () => {
    expect(showLibraryNav("sync", false)).toBe(true);
    expect(showLibraryNav("sync", true)).toBe(true);
  });

  it("keeps the tree visible during the embed/score window (staging, no proposal yet)", () => {
    expect(showLibraryNav("staging", false)).toBe(true);
  });

  it("hides the tree once a proposal is ready (staging panel takes over)", () => {
    expect(showLibraryNav("staging", true)).toBe(false);
  });

  it("hides the tree in topics mode", () => {
    expect(showLibraryNav("topics", false)).toBe(false);
  });
});
