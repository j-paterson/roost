// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { renderChip } from "../chip";

describe("renderChip", () => {
  it("renders a chip with correct class", () => {
    const c = document.createElement("div");
    renderChip(c, { kind: "price", value: "$299" });
    const chip = c.querySelector(".roost-chip");
    expect(chip).not.toBeNull();
    expect(chip?.classList.contains("roost-chip--price")).toBe(true);
    expect(chip?.textContent).toContain("$299");
  });

  it("returns null for empty value", () => {
    const c = document.createElement("div");
    expect(renderChip(c, { kind: "tag", value: "" })).toBeNull();
    expect(c.querySelector(".roost-chip")).toBeNull();
  });

  it("returns null for null", () => {
    const c = document.createElement("div");
    expect(renderChip(c, { kind: "tag", value: null })).toBeNull();
  });

  it("filters string 'null'/'undefined'", () => {
    const c = document.createElement("div");
    expect(renderChip(c, { kind: "tag", value: "null" })).toBeNull();
  });

  it("renders compact by default", () => {
    const c = document.createElement("div");
    renderChip(c, { kind: "time", value: "10m" });
    expect(c.querySelector(".roost-chip")?.classList.contains("roost-chip--compact")).toBe(true);
  });

  it("renders full variant", () => {
    const c = document.createElement("div");
    renderChip(c, { kind: "time", value: "10m", variant: "full" });
    expect(c.querySelector(".roost-chip")?.classList.contains("roost-chip--full")).toBe(true);
  });

  it("renders numeric values", () => {
    const c = document.createElement("div");
    renderChip(c, { kind: "rating", value: 4.5 });
    expect(c.querySelector(".roost-chip")?.textContent).toContain("4.5");
  });
});
