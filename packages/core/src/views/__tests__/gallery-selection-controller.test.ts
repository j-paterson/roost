// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { GallerySelectionController } from "../gallery-selection";

function makeHost() {
  const container = document.createElement("div");
  const scrollEl = document.createElement("div");
  return {
    getGalleryContainer: () => container,
    getGalleryScrollEl: () => scrollEl,
    getGallerySelectionBar: () => null as HTMLElement | null, // no DOM bar in unit tests
    getRoostPlugin: () => null,
    getCurrentFilter: () => null,
  };
}

describe("GallerySelectionController — Finder-style free selection", () => {
  it("selectSingle selects only the given id and sets anchor", () => {
    const ctrl = new GallerySelectionController(makeHost());
    ctrl.selectSingle("a");
    expect(ctrl.has("a")).toBe(true);
    expect(ctrl.getSelected()).toEqual(["a"]);
    expect(ctrl.anchor).toBe("a");
  });

  it("selectSingle clears previous selection", () => {
    const ctrl = new GallerySelectionController(makeHost());
    ctrl.selectSingle("a");
    ctrl.selectSingle("b");
    expect(ctrl.has("a")).toBe(false);
    expect(ctrl.has("b")).toBe(true);
  });

  it("toggleId adds when absent", () => {
    const ctrl = new GallerySelectionController(makeHost());
    ctrl.toggleId("a");
    expect(ctrl.has("a")).toBe(true);
  });

  it("toggleId removes when present", () => {
    const ctrl = new GallerySelectionController(makeHost());
    ctrl.selectSingle("a");
    ctrl.toggleId("a");
    expect(ctrl.has("a")).toBe(false);
  });

  it("toggleId sets anchor", () => {
    const ctrl = new GallerySelectionController(makeHost());
    ctrl.toggleId("b");
    expect(ctrl.anchor).toBe("b");
  });

  it("selectRange selects anchor-to-clicked span — forward direction", () => {
    const ctrl = new GallerySelectionController(makeHost());
    const ordered = ["a", "b", "c", "d", "e"];
    ctrl.selectSingle("b");          // anchor = "b"
    ctrl.selectRange("d", ordered);  // expect b, c, d
    expect(new Set(ctrl.getSelected())).toEqual(new Set(["b", "c", "d"]));
  });

  it("selectRange selects anchor-to-clicked span — backward direction", () => {
    const ctrl = new GallerySelectionController(makeHost());
    const ordered = ["a", "b", "c", "d", "e"];
    ctrl.selectSingle("d");          // anchor = "d"
    ctrl.selectRange("b", ordered);  // expect b, c, d
    expect(new Set(ctrl.getSelected())).toEqual(new Set(["b", "c", "d"]));
  });

  it("selectRange falls back to selectSingle when anchor not in ordered list", () => {
    const ctrl = new GallerySelectionController(makeHost());
    ctrl.selectSingle("z");          // anchor = "z" (not in ordered)
    ctrl.selectRange("b", ["a", "b", "c"]);
    expect(ctrl.getSelected()).toEqual(["b"]);
  });

  it("selectAll selects every id in the ordered list", () => {
    const ctrl = new GallerySelectionController(makeHost());
    ctrl.selectAll(["a", "b", "c"]);
    expect(new Set(ctrl.getSelected())).toEqual(new Set(["a", "b", "c"]));
  });

  it("clear empties selection and nulls anchor", () => {
    const ctrl = new GallerySelectionController(makeHost());
    ctrl.selectAll(["a", "b"]);
    ctrl.clear();
    expect(ctrl.getSelected()).toEqual([]);
    expect(ctrl.anchor).toBeNull();
  });

  it("has returns false when id is not selected", () => {
    const ctrl = new GallerySelectionController(makeHost());
    expect(ctrl.has("x")).toBe(false);
  });
});
