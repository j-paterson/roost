import { describe, it, expect } from "vitest";
import { instagram } from "@/platforms/instagram";
import { enabledPlatforms } from "@/platforms/registry";

describe("instagram descriptor (Phase 2 enabled)", () => {
  it("is enabled with a sync fn", () => {
    expect(instagram.enabled).toBe(true);
    expect(typeof instagram.sync).toBe("function");
  });
  it("appears in enabledPlatforms()", () => {
    expect(enabledPlatforms().some((p) => p.id === "instagram")).toBe(true);
  });
});
