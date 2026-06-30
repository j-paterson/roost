import { describe, it, expect } from "vitest";
import { reddit } from "@/platforms/reddit";
import { enabledPlatforms } from "@/platforms/registry";

describe("reddit descriptor (enabled + sync wired)", () => {
  it("is enabled with a sync fn", () => {
    expect(reddit.enabled).toBe(true);
    expect(typeof reddit.sync).toBe("function");
  });
  it("appears in enabledPlatforms()", () => {
    expect(enabledPlatforms().some((p) => p.id === "reddit")).toBe(true);
  });
});
