import { describe, it, expect } from "vitest";
import { resolveBinary } from "@/integrations/detect";

describe("resolveBinary", () => {
  it("returns the first existing candidate path", () => {
    const exists = (p: string) => p === "/usr/local/bin/ffmpeg";
    const path = resolveBinary("ffmpeg", {
      pathDirs: ["/usr/bin", "/usr/local/bin"],
      extraDirs: [],
      exists,
    });
    expect(path).toBe("/usr/local/bin/ffmpeg");
  });

  it("checks extraDirs after PATH dirs", () => {
    const exists = (p: string) => p === "/opt/homebrew/bin/ffmpeg";
    const path = resolveBinary("ffmpeg", {
      pathDirs: ["/usr/bin"],
      extraDirs: ["/opt/homebrew/bin"],
      exists,
    });
    expect(path).toBe("/opt/homebrew/bin/ffmpeg");
  });

  it("returns null when no candidate exists", () => {
    const path = resolveBinary("nope", {
      pathDirs: ["/usr/bin"],
      extraDirs: ["/opt/homebrew/bin"],
      exists: () => false,
    });
    expect(path).toBeNull();
  });
});
