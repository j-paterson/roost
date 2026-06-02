import { describe, it, expect } from "vitest";
import { INTEGRATIONS, getIntegration } from "@/integrations/registry";

describe("integration registry", () => {
  it("has exactly the four integrations with stable ids", () => {
    expect(INTEGRATIONS.map((i) => i.id).sort()).toEqual(
      ["ffmpeg", "ollama", "sidecar", "vault-search"],
    );
  });

  it("each descriptor has a label, unlocks text, flagKey, kind, and setup instructions", () => {
    for (const i of INTEGRATIONS) {
      expect(i.label.length).toBeGreaterThan(0);
      expect(i.unlocks.length).toBeGreaterThan(0);
      expect(i.flagKey.length).toBeGreaterThan(0);
      expect(["server", "cli"]).toContain(i.kind);
      expect(i.setup.instructions.length).toBeGreaterThan(0);
    }
  });

  it("ollama detect returns available when the http probe succeeds", async () => {
    const ollama = getIntegration("ollama");
    const status = await ollama.detect({
      httpProbe: async () => true,
      resolveBinary: () => null,
    });
    expect(status).toBe("available");
  });

  it("ffmpeg detect returns unavailable when ffmpeg binary is missing", async () => {
    const ffmpeg = getIntegration("ffmpeg");
    const status = await ffmpeg.detect({
      httpProbe: async () => false,
      resolveBinary: () => null,
    });
    expect(status).toBe("unavailable");
  });

  it("ffmpeg detect returns available when both ffmpeg and ffprobe resolve", async () => {
    const ffmpeg = getIntegration("ffmpeg");
    const status = await ffmpeg.detect({
      httpProbe: async () => false,
      resolveBinary: (name) => `/usr/bin/${name}`,
    });
    expect(status).toBe("available");
  });
});
