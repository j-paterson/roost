import { OLLAMA_URL, EMBED_URL } from "@/config";
import type { IntegrationFlags } from "@/settings";

export type IntegrationId = "ollama" | "sidecar" | "ffmpeg" | "vault-search";
export type DetectStatus = "available" | "unavailable";

/** IO injected into detect() so it unit-tests without real network/fs. */
export interface DetectCtx {
  httpProbe: (url: string) => Promise<boolean>;
  resolveBinary: (name: string) => string | null;
}

export interface Integration {
  id: IntegrationId;
  label: string;
  /** One-line "what enabling this unlocks". */
  unlocks: string;
  flagKey: keyof IntegrationFlags;
  kind: "server" | "cli";
  detect(ctx: DetectCtx): Promise<DetectStatus>;
  setup: { instructions: string; docsUrl?: string };
}

export const INTEGRATIONS: Integration[] = [
  {
    id: "ollama",
    label: "Ollama",
    unlocks: "Local embeddings and LLM rerank for Smart Assign.",
    flagKey: "ollama",
    kind: "server",
    detect: async (ctx) =>
      (await ctx.httpProbe(`${OLLAMA_URL}/api/tags`)) ? "available" : "unavailable",
    setup: {
      instructions:
        "Easiest: run `npm run setup:integrations` (or `scripts/setup-integrations.sh`) — it installs Ollama, starts it, and pulls the models Roost uses. Manual: install from ollama.com → `ollama serve` → `ollama pull nomic-embed-text` + a chat model.",
      docsUrl: "https://ollama.com",
    },
  },
  {
    id: "sidecar",
    label: "Embedding sidecar",
    unlocks: "Fine-tuned embeddings (higher accuracy than base Ollama).",
    flagKey: "sidecar",
    kind: "server",
    detect: async (ctx) =>
      (await ctx.httpProbe(`${EMBED_URL}/api/tags`)) ? "available" : "unavailable",
    setup: {
      instructions:
        "Optional (Ollama already provides embeddings). Easiest: `scripts/setup-integrations.sh --vault-root <vault>` sets up the Python venv and starts it on :11435 with a base model; drop a fine-tuned model in `.roost/build/nomic-finetuned-hardneg` for higher accuracy.",
    },
  },
  {
    id: "ffmpeg",
    label: "ffmpeg",
    unlocks: "Reddit v.redd.it video download (audio/video muxing).",
    flagKey: "ffmpeg",
    kind: "cli",
    detect: async (ctx) =>
      Boolean(ctx.resolveBinary("ffmpeg") && ctx.resolveBinary("ffprobe")) ? "available" : "unavailable",
    setup: {
      instructions: "Install ffmpeg (e.g. `brew install ffmpeg`) so `ffmpeg` and `ffprobe` are on your PATH.",
    },
  },
  {
    id: "vault-search",
    label: "Vault search CLI",
    unlocks: "Semantic vault-search command.",
    flagKey: "vaultSearch",
    kind: "cli",
    detect: async (ctx) =>
      ctx.resolveBinary("vault-search") ? "available" : "unavailable",
    setup: {
      instructions: "Bundled with Roost. Run `scripts/setup-integrations.sh --with-search` (from the plugin's scripts dir) to build it and put `vault-search` on your PATH.",
    },
  },
];

export function getIntegration(id: IntegrationId): Integration {
  const found = INTEGRATIONS.find((i) => i.id === id);
  if (!found) throw new Error(`unknown integration: ${id}`);
  return found;
}

interface CacheEntry { status: DetectStatus; at: number; }
const DETECT_TTL_MS = 5_000;
const cache = new Map<IntegrationId, CacheEntry>();

/** Detect availability with a short TTL cache. `now` is injectable for testing. */
export async function detectIntegration(
  id: IntegrationId,
  ctx: DetectCtx,
  now: number,
): Promise<DetectStatus> {
  const cached = cache.get(id);
  if (cached && now - cached.at < DETECT_TTL_MS) return cached.status;
  const status = await getIntegration(id).detect(ctx);
  cache.set(id, { status, at: now });
  return status;
}

/** Clear cached detection (call after a flag toggle so the next probe is fresh). */
export function clearDetectCache(): void {
  cache.clear();
}
