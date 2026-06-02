import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ollamaGenerate } from "@/pipeline/shared";
import { __setRequestUrlImpl, __resetRequestUrlImpl } from "obsidian";

describe("ollamaGenerate", () => {
  let lastBody: Record<string, unknown> | null = null;
  let lastUrl: string | null = null;

  beforeEach(() => {
    lastBody = null;
    lastUrl = null;
    __setRequestUrlImpl(async req => {
      lastUrl = req.url;
      lastBody = req.body ? JSON.parse(req.body) : null;
      return { status: 200, json: { response: "hello\n" }, text: JSON.stringify({ response: "hello\n" }) };
    });
  });

  afterEach(() => {
    __resetRequestUrlImpl();
  });

  it("posts to /api/generate on the default ollama URL with EVAL_MODEL", async () => {
    await ollamaGenerate("prompt");
    expect(lastUrl).toBe("http://localhost:11434/api/generate");
    expect(lastBody).toMatchObject({ model: "gemma4:e4b", prompt: "prompt", stream: false });
  });

  it("returns the response trimmed", async () => {
    const out = await ollamaGenerate("prompt");
    expect(out).toBe("hello");
  });

  it("threads numPredict, numCtx, temperature into options", async () => {
    await ollamaGenerate("p", { numPredict: 42, numCtx: 1024, temperature: 0.3 });
    expect(lastBody).toMatchObject({
      options: { num_predict: 42, num_ctx: 1024, temperature: 0.3 },
    });
  });

  it("defaults temperature to 0 when omitted", async () => {
    await ollamaGenerate("p");
    expect((lastBody as { options: { temperature: number } }).options.temperature).toBe(0);
  });

  it("honours a custom ollamaUrl", async () => {
    await ollamaGenerate("p", { ollamaUrl: "http://other:11434" });
    expect(lastUrl).toBe("http://other:11434/api/generate");
  });

  it("honours a custom model", async () => {
    await ollamaGenerate("p", { model: "llama3.2:3b" });
    expect((lastBody as { model: string }).model).toBe("llama3.2:3b");
  });

  it("throws on non-200 status", async () => {
    __setRequestUrlImpl(async () => ({ status: 500, json: {}, text: "server error" }));
    await expect(ollamaGenerate("p")).rejects.toThrow(/500/);
  });

  it("aborts when signal fires", async () => {
    __setRequestUrlImpl(() => new Promise(() => { /* never resolves */ }));
    const ac = new AbortController();
    const p = ollamaGenerate("p", { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow(/abort/i);
  });
});
