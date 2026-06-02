// @vitest-environment node
import { describe, it, expect } from "vitest";
import { OllamaEmbedder, HttpEmbedder, SidecarEmbedder, selectEmbedder } from "@/lib/embedder";

// ── OllamaEmbedder ───────────────────────────────────────────────────────────

describe("OllamaEmbedder", () => {
  it("has name 'ollama' and ready=true on construct", () => {
    const e = new OllamaEmbedder();
    expect(e.name).toBe("ollama");
    expect(e.ready).toBe(true);
    e.dispose();
  });

  it("dispose sets ready=false", () => {
    const e = new OllamaEmbedder();
    e.dispose();
    expect(e.ready).toBe(false);
  });

  it("accepts a custom base URL override", () => {
    const e = new OllamaEmbedder("http://custom-host:11434");
    expect(e.name).toBe("ollama");
    expect(e.ready).toBe(true);
    e.dispose();
  });
});

// ── HttpEmbedder ─────────────────────────────────────────────────────────────

describe("HttpEmbedder", () => {
  it("has the given name and ready=true on construct", () => {
    const e = new HttpEmbedder("test-http", "http://localhost:9999");
    expect(e.name).toBe("test-http");
    expect(e.ready).toBe(true);
    e.dispose();
  });

  it("dispose sets ready=false", () => {
    const e = new HttpEmbedder("test-http", "http://localhost:9999");
    e.dispose();
    expect(e.ready).toBe(false);
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────

const sidecarUp: () => Promise<boolean> = () => Promise.resolve(true);
const sidecarDown: () => Promise<boolean> = () => Promise.resolve(false);

// ── selectEmbedder factory ────────────────────────────────────────────────────

describe("selectEmbedder", () => {
  it("auto + sidecar down → OllamaEmbedder", async () => {
    const e = await selectEmbedder({
      probeSidecar: sidecarDown,
      settings: { embeddingBackend: "auto" },
    });
    expect(e).toBeInstanceOf(OllamaEmbedder);
    expect(e.name).toBe("ollama");
    e.dispose();
  });

  it("auto + sidecar up → SidecarEmbedder", async () => {
    const e = await selectEmbedder({
      probeSidecar: sidecarUp,
      settings: { embeddingBackend: "auto" },
    });
    expect(e).toBeInstanceOf(SidecarEmbedder);
    expect(e.name).toBe("sidecar");
    e.dispose();
  });

  it("explicit 'ollama' → OllamaEmbedder regardless of sidecar", async () => {
    const e = await selectEmbedder({
      probeSidecar: sidecarUp, // sidecar up but should be ignored
      settings: { embeddingBackend: "ollama" },
    });
    expect(e).toBeInstanceOf(OllamaEmbedder);
    expect(e.name).toBe("ollama");
    e.dispose();
  });

  it("explicit 'sidecar' → SidecarEmbedder regardless of probe", async () => {
    const e = await selectEmbedder({
      probeSidecar: sidecarDown, // probe would say down but explicit setting wins
      settings: { embeddingBackend: "sidecar" },
    });
    expect(e).toBeInstanceOf(SidecarEmbedder);
    expect(e.name).toBe("sidecar");
    e.dispose();
  });
});

// ── SidecarEmbedder ──────────────────────────────────────────────────────────

describe("SidecarEmbedder", () => {
  it("has name 'sidecar' and ready=true on construct", () => {
    const e = new SidecarEmbedder();
    expect(e.name).toBe("sidecar");
    expect(e.ready).toBe(true);
    e.dispose();
  });

  it("dispose sets ready=false", () => {
    const e = new SidecarEmbedder();
    e.dispose();
    expect(e.ready).toBe(false);
  });
});
