/**
 * LLM provider abstraction. Lets the plugin switch between local (Ollama)
 * and cloud (Anthropic, OpenAI) backends without rewriting every call site.
 *
 * Public surface:
 *   - LLMProvider — interface every provider implements (generate text from a
 *     prompt, with optional model/temperature/token-budget overrides).
 *   - OllamaProvider — wraps the existing /api/generate flow.
 *   - AnthropicProvider — wraps api.anthropic.com /v1/messages.
 *   - getActiveProvider() — global accessor; main.ts calls setActiveProvider()
 *     on plugin load + whenever settings change.
 *
 * Embed calls (vector embeddings) are NOT part of this abstraction. Embeddings
 * still go through the Python sidecar / nomic-embed-text. Item G in the
 * roadmap (bundled WASM/ONNX embedder) replaces the embed path; this only
 * covers text generation.
 *
 * Smart Assign's T1+T2 paths in evaluate.ts call requestUrl directly today
 * with their own retry / disagree-reject logic — they are NOT yet routed
 * through this abstraction. Extraction pipelines (recipe, place, media,
 * product, tutorial, workout, home) are.
 */

import { requestUrl } from "obsidian";
import { OLLAMA_URL, EVAL_MODEL, OLLAMA_NUM_CTX } from "@/config";

export type LLMBackend = "local" | "cloud" | "skip";

export interface GenerateOpts {
  /** Model name, provider-specific. Defaults to the provider's configured default. */
  model?: string;
  /** Max output tokens (provider-specific naming: num_predict for Ollama,
   *  max_tokens for Anthropic, max_completion_tokens for OpenAI). */
  numPredict?: number;
  /** Context window size (Ollama-only — cloud providers manage their own). */
  numCtx?: number;
  /** Temperature; default 0 for deterministic extraction work. */
  temperature?: number;
  /** Abort signal — provider should reject on abort. */
  signal?: AbortSignal;
  /** Override base URL (Ollama only — cloud endpoints are fixed). */
  ollamaUrl?: string;
}

export interface LLMProvider {
  readonly kind: LLMBackend;
  /** Friendly name for logs / status surfaces. */
  readonly label: string;
  /** Run a prompt through the provider and return the trimmed response text.
   *  Throws on non-OK status or abort. */
  generate(prompt: string, opts?: GenerateOpts): Promise<string>;
}

// ── Ollama ─────────────────────────────────────────────────────────────────

let onLLMRequest: (() => void) | null = null;

/** Optional hook called before each Ollama request. Callers may install this
 *  to track request activity (e.g. for health monitoring or logging). */
export function setLLMRequestHook(fn: (() => void) | null): void {
  onLLMRequest = fn;
}

export class OllamaProvider implements LLMProvider {
  readonly kind = "local" as const;
  readonly label = "Ollama (local)";

  async generate(prompt: string, opts: GenerateOpts = {}): Promise<string> {
    const url = `${opts.ollamaUrl ?? OLLAMA_URL}/api/generate`;
    const body = JSON.stringify({
      model: opts.model ?? EVAL_MODEL,
      prompt,
      stream: false,
      // Mandatory for gemma reasoning models — without it the model consumes
      // the entire num_predict budget on internal thinking and returns empty
      // content with done_reason=length. Harmless no-op for non-reasoning
      // models (Ollama ignores it). Documented in user memory.
      think: false,
      options: {
        temperature: opts.temperature ?? 0,
        num_predict: opts.numPredict ?? 512,
        num_ctx: opts.numCtx ?? OLLAMA_NUM_CTX,
      },
    });

    if (onLLMRequest) onLLMRequest();
    const req = requestUrl({ url, method: "POST", headers: { "Content-Type": "application/json" }, body });

    const res = opts.signal
      ? await Promise.race([
          req,
          new Promise<never>((_, reject) => {
            if (opts.signal!.aborted) reject(new Error("aborted"));
            opts.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
        ])
      : await req;

    if (res.status !== 200) {
      throw new Error(`OllamaProvider.generate: status ${res.status}`);
    }
    const json = res.json as { response?: string };
    return (json.response ?? "").trim();
  }
}

// ── Anthropic ──────────────────────────────────────────────────────────────

export interface AnthropicConfig {
  apiKey: string;
  /** Default model for this provider. e.g. "claude-haiku-4-5-20251001". */
  defaultModel?: string;
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export class AnthropicProvider implements LLMProvider {
  readonly kind = "cloud" as const;
  readonly label = "Anthropic (cloud)";
  private cfg: AnthropicConfig;

  constructor(cfg: AnthropicConfig) {
    if (!cfg.apiKey) throw new Error("AnthropicProvider requires an apiKey");
    this.cfg = cfg;
  }

  async generate(prompt: string, opts: GenerateOpts = {}): Promise<string> {
    const body = JSON.stringify({
      model: opts.model ?? this.cfg.defaultModel ?? ANTHROPIC_DEFAULT_MODEL,
      max_tokens: opts.numPredict ?? 1024,
      temperature: opts.temperature ?? 0,
      messages: [{ role: "user", content: prompt }],
    });

    const req = requestUrl({
      url: ANTHROPIC_URL,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.cfg.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body,
      throw: false,
    });

    const res = opts.signal
      ? await Promise.race([
          req,
          new Promise<never>((_, reject) => {
            if (opts.signal!.aborted) reject(new Error("aborted"));
            opts.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
        ])
      : await req;

    if (res.status !== 200) {
      const errText = res.text?.slice(0, 200) ?? "";
      throw new Error(`AnthropicProvider.generate: status ${res.status}${errText ? " — " + errText : ""}`);
    }
    // Anthropic /v1/messages response: { content: [{ type: "text", text: "..." }] }
    const json = res.json as { content?: { type: string; text?: string }[] };
    const textBlock = json.content?.find((b) => b.type === "text");
    return (textBlock?.text ?? "").trim();
  }
}

// ── Skip / no-op ───────────────────────────────────────────────────────────

/** Used when the user picked "skip" in the wizard. Throwing is intentional —
 *  callers should gate on backend before invoking. */
export class SkipProvider implements LLMProvider {
  readonly kind = "skip" as const;
  readonly label = "Skip (no AI)";
  async generate(): Promise<string> {
    throw new Error(
      "LLM backend is set to 'skip'. Enable Local or Cloud in Settings to use AI features.",
    );
  }
}

// ── Active-provider singleton ──────────────────────────────────────────────

let activeProvider: LLMProvider = new OllamaProvider();

export function setActiveProvider(p: LLMProvider): void {
  activeProvider = p;
}

export function getActiveProvider(): LLMProvider {
  return activeProvider;
}

// ── Factory ────────────────────────────────────────────────────────────────

export interface ProviderSettings {
  llmBackend: LLMBackend;
  anthropicApiKey?: string;
  anthropicModel?: string;
}

/** Build a provider from the relevant subset of plugin settings. Falls back
 *  to OllamaProvider if the chosen backend is misconfigured (e.g. cloud with
 *  empty key) — keeps the plugin functional rather than throwing on load. */
export function buildProviderFromSettings(s: ProviderSettings): LLMProvider {
  if (s.llmBackend === "cloud" && s.anthropicApiKey) {
    return new AnthropicProvider({
      apiKey: s.anthropicApiKey,
      defaultModel: s.anthropicModel,
    });
  }
  if (s.llmBackend === "skip") {
    return new SkipProvider();
  }
  return new OllamaProvider();
}
