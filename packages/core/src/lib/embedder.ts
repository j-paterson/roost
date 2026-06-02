/**
 * Embedder abstraction — lets the plugin switch between embedding backends
 * without rewriting every call site.
 *
 * Public surface:
 *   - Embedder            — interface every implementation satisfies
 *   - HttpEmbedder        — base HTTP embedder (POST /api/embed)
 *   - OllamaEmbedder      — HTTP to Ollama (port 11434, nomic-embed-text)
 *   - SidecarEmbedder     — HTTP to the Python fine-tuned sidecar (port 11435)
 *   - SelectEmbedderOpts  — opts type for the factory
 *   - selectEmbedder      — factory: picks backend based on settings + probe
 */

import { requestUrl } from "obsidian";
import { OLLAMA_URL, EMBED_MODEL, EMBED_URL } from "@/config";

// ── Interface ─────────────────────────────────────────────────────────────────

export interface Embedder {
  /** Identifies the backend: "sidecar" | "ollama" */
  readonly name: string;
  /** True when the embedder is initialised and ready to serve requests. */
  readonly ready: boolean;
  /**
   * Embed a batch of texts, returning one float vector per input string.
   * The returned array has the same length as `texts`.
   */
  embed(texts: string[]): Promise<number[][]>;
  /** Release any held resources. Safe to call multiple times. */
  dispose(): void;
}

// ── HttpEmbedder ──────────────────────────────────────────────────────────────

/**
 * HTTP embedder shared by SidecarEmbedder and OllamaEmbedder.
 * Wire format: POST /api/embed { model, input } → { embeddings: number[][] }
 */
export class HttpEmbedder implements Embedder {
  private _ready = true;

  constructor(
    readonly name: string,
    private readonly baseUrl: string,
  ) {}

  get ready(): boolean {
    return this._ready;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await requestUrl({
      url: `${this.baseUrl}/api/embed`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    });

    if (res.status !== 200) {
      throw new Error(`${this.name} embedder: HTTP ${res.status}`);
    }

    const json = res.json as { embeddings?: number[][] };
    if (!Array.isArray(json.embeddings) || json.embeddings.length !== texts.length) {
      throw new Error(
        `${this.name} embedder: expected ${texts.length} embeddings, got ${json.embeddings?.length ?? "none"}`,
      );
    }
    return json.embeddings;
  }

  dispose(): void {
    this._ready = false;
  }
}

/** HTTP embedder for Ollama (port 11434, nomic-embed-text). */
export class OllamaEmbedder extends HttpEmbedder {
  constructor(ollamaUrl?: string) {
    super("ollama", (ollamaUrl ?? OLLAMA_URL).replace(/\/$/, ""));
  }
}

// ── Factory opts type ─────────────────────────────────────────────────────────

export interface SelectEmbedderOpts {
  /** Async probe — returns true if the sidecar HTTP server is reachable. */
  probeSidecar: () => Promise<boolean>;
  /** Plugin settings subset. `embeddingBackend` values: "auto" | "sidecar" | "ollama" */
  settings: { embeddingBackend: string };
  /** Override the sidecar base URL (defaults to EMBED_URL). */
  sidecarUrl?: string;
  /** Override the Ollama base URL (defaults to OLLAMA_URL). */
  ollamaUrl?: string;
}

// ── SidecarEmbedder ──────────────────────────────────────────────────────────

/** HTTP embedder for the Python fine-tuned sidecar (port 11435). */
export class SidecarEmbedder extends HttpEmbedder {
  constructor(sidecarUrl?: string) {
    super("sidecar", (sidecarUrl ?? EMBED_URL).replace(/\/$/, ""));
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export async function selectEmbedder(opts: SelectEmbedderOpts): Promise<Embedder> {
  const { settings, sidecarUrl, ollamaUrl, probeSidecar } = opts;

  switch (settings.embeddingBackend) {
    case "ollama":
      return new OllamaEmbedder(ollamaUrl);

    case "sidecar":
      return new SidecarEmbedder(sidecarUrl);

    default: {
      // "auto" or any unrecognised value — probe the sidecar, else Ollama.
      const up = await probeSidecar();
      return up ? new SidecarEmbedder(sidecarUrl) : new OllamaEmbedder(ollamaUrl);
    }
  }
}
