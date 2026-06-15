import { describe, it, expect } from "vitest";
import { classifyMismatch, type EmbeddingProvenance } from "../embedding-provenance";

const prov = (over: Partial<EmbeddingProvenance> = {}): EmbeddingProvenance => ({
  source: "sidecar", model: "fine-tuned", embeddedAt: "2026-06-15T00:00:00Z", vaultPath: "/vault", ...over,
});

describe("classifyMismatch", () => {
  it("no provenance → none", () => {
    expect(classifyMismatch(null, "ollama", "/vault")).toEqual({ kind: "none" });
  });
  it("sidecar provenance but now running ollama → sidecar-down (the alarm)", () => {
    expect(classifyMismatch(prov({ source: "sidecar" }), "ollama", "/vault")).toEqual({ kind: "sidecar-down" });
  });
  it("vault moved → vault-moved (with paths)", () => {
    expect(classifyMismatch(prov({ vaultPath: "/old" }), "sidecar", "/new"))
      .toEqual({ kind: "vault-moved", was: "/old", now: "/new" });
  });
  it("sidecar-down takes precedence over vault-moved (both true → report degradation)", () => {
    expect(classifyMismatch(prov({ source: "sidecar", vaultPath: "/old" }), "ollama", "/new"))
      .toEqual({ kind: "sidecar-down" });
  });
  it("ollama provenance but sidecar now active → upgrade-available", () => {
    expect(classifyMismatch(prov({ source: "ollama" }), "sidecar", "/vault")).toEqual({ kind: "upgrade-available" });
  });
  it("aligned → match", () => {
    expect(classifyMismatch(prov({ source: "sidecar" }), "sidecar", "/vault")).toEqual({ kind: "match" });
  });
});
