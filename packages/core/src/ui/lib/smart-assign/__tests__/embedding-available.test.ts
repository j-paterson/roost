import { describe, it, expect } from "vitest";
import { embeddingBackendAvailable } from "@/ui/lib/smart-assign/embedding-available";

const flags = (o: Partial<{ ollama: boolean; sidecar: boolean }>) => ({
  ollama: false, sidecar: false, ffmpeg: false, vaultSearch: false, ...o,
});

describe("embeddingBackendAvailable", () => {
  it("false when both backends off", () => {
    expect(embeddingBackendAvailable(flags({}), { ollama: "unknown", sidecar: "unknown" })).toBe(false);
  });
  it("false when a backend is on but unavailable", () => {
    expect(embeddingBackendAvailable(flags({ ollama: true }), { ollama: "unavailable", sidecar: "unknown" })).toBe(false);
  });
  it("true when ollama on and available", () => {
    expect(embeddingBackendAvailable(flags({ ollama: true }), { ollama: "available", sidecar: "unknown" })).toBe(true);
  });
  it("true when sidecar on and available", () => {
    expect(embeddingBackendAvailable(flags({ sidecar: true }), { ollama: "unknown", sidecar: "available" })).toBe(true);
  });
});
