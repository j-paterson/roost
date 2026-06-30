import { describe, it, expect } from "vitest";
import { detectPlatformFromUrl } from "@/lib/extract";

describe("eagle import — instagram detection", () => {
  it("detectPlatformFromUrl recognizes instagram.com", () => {
    expect(detectPlatformFromUrl("https://www.instagram.com/p/Cabc123/")).toBe("instagram");
  });
});
