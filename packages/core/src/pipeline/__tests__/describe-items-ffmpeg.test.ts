import { describe, it, expect } from "vitest";
import { resolveFfmpeg } from "@/pipeline/describe-items";

describe("resolveFfmpeg", () => {
  it("returns null paths when the flag is off", () => {
    const r = resolveFfmpeg(false, () => "/usr/bin/x");
    expect(r).toEqual({ ffmpeg: null, ffprobe: null });
  });

  it("returns null paths when binaries are missing even if flag on", () => {
    const r = resolveFfmpeg(true, () => null);
    expect(r).toEqual({ ffmpeg: null, ffprobe: null });
  });

  it("returns resolved paths when flag on and both binaries found", () => {
    const r = resolveFfmpeg(true, (name) => `/opt/homebrew/bin/${name}`);
    expect(r).toEqual({ ffmpeg: "/opt/homebrew/bin/ffmpeg", ffprobe: "/opt/homebrew/bin/ffprobe" });
  });

  it("returns null paths when only one of the two resolves", () => {
    const r = resolveFfmpeg(true, (name) => (name === "ffmpeg" ? "/usr/bin/ffmpeg" : null));
    expect(r).toEqual({ ffmpeg: null, ffprobe: null });
  });
});
