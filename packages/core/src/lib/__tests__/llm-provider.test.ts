// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import {
  __setRequestUrlImpl,
  __resetRequestUrlImpl,
} from "obsidian";
import {
  OllamaProvider,
  AnthropicProvider,
  SkipProvider,
  buildProviderFromSettings,
  setActiveProvider,
  getActiveProvider,
} from "../llm-provider";

describe("llm-provider", () => {
  beforeEach(() => {
    __resetRequestUrlImpl();
  });

  describe("OllamaProvider", () => {
    it("calls /api/generate and returns trimmed response", async () => {
      let captured: { url?: string; body?: string } = {};
      __setRequestUrlImpl(async (req) => {
        captured = { url: req.url, body: req.body as string };
        return {
          status: 200,
          json: { response: "  recipe  " },
          text: "",
        };
      });

      const p = new OllamaProvider();
      const out = await p.generate("triage this", { numPredict: 5 });

      expect(captured.url).toContain("/api/generate");
      const parsed = JSON.parse(captured.body!);
      expect(parsed.prompt).toBe("triage this");
      expect(parsed.options.num_predict).toBe(5);
      expect(out).toBe("recipe");
    });

    it("throws on non-200", async () => {
      __setRequestUrlImpl(async () => ({ status: 500, json: null, text: "internal" }));
      const p = new OllamaProvider();
      await expect(p.generate("x")).rejects.toThrow(/status 500/);
    });
  });

  describe("AnthropicProvider", () => {
    it("calls /v1/messages with the api key + version header", async () => {
      let captured: { url?: string; headers?: Record<string, string>; body?: string } = {};
      __setRequestUrlImpl(async (req) => {
        captured = { url: req.url, headers: req.headers as Record<string, string>, body: req.body as string };
        return {
          status: 200,
          json: { content: [{ type: "text", text: "  Test Dish  " }] },
          text: "",
        };
      });

      const p = new AnthropicProvider({ apiKey: "sk-test", defaultModel: "claude-haiku-4-5-20251001" });
      const out = await p.generate("extract", { numPredict: 100 });

      expect(captured.url).toContain("api.anthropic.com");
      expect(captured.headers?.["x-api-key"]).toBe("sk-test");
      expect(captured.headers?.["anthropic-version"]).toBeDefined();
      const parsed = JSON.parse(captured.body!);
      expect(parsed.model).toBe("claude-haiku-4-5-20251001");
      expect(parsed.max_tokens).toBe(100);
      expect(parsed.messages[0].content).toBe("extract");
      expect(out).toBe("Test Dish");
    });

    it("throws on non-200 with body excerpt", async () => {
      __setRequestUrlImpl(async () => ({ status: 401, json: null, text: "invalid x-api-key" }));
      const p = new AnthropicProvider({ apiKey: "sk-bogus" });
      await expect(p.generate("x")).rejects.toThrow(/401/);
    });

    it("throws on construct without apiKey", () => {
      expect(() => new AnthropicProvider({ apiKey: "" })).toThrow();
    });
  });

  describe("SkipProvider", () => {
    it("throws on generate with a helpful message", async () => {
      const p = new SkipProvider();
      await expect(p.generate()).rejects.toThrow(/skip|Settings/);
    });
  });

  describe("buildProviderFromSettings", () => {
    it("returns Ollama for backend=local", () => {
      const p = buildProviderFromSettings({ llmBackend: "local" });
      expect(p.kind).toBe("local");
    });

    it("returns Anthropic for backend=cloud with key", () => {
      const p = buildProviderFromSettings({ llmBackend: "cloud", anthropicApiKey: "sk-test" });
      expect(p.kind).toBe("cloud");
    });

    it("falls back to Ollama if backend=cloud but no key", () => {
      const p = buildProviderFromSettings({ llmBackend: "cloud", anthropicApiKey: "" });
      expect(p.kind).toBe("local");
    });

    it("returns Skip for backend=skip", () => {
      const p = buildProviderFromSettings({ llmBackend: "skip" });
      expect(p.kind).toBe("skip");
    });
  });

  describe("active provider singleton", () => {
    it("setActiveProvider / getActiveProvider round-trip", () => {
      const skip = new SkipProvider();
      setActiveProvider(skip);
      expect(getActiveProvider()).toBe(skip);
      // Reset to a sane default for other tests in this run.
      setActiveProvider(new OllamaProvider());
    });
  });
});
