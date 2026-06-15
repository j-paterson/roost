import { OLLAMA_URL, EMBED_MODEL, EMBED_BATCH_SIZE, EMBED_CONCURRENCY } from "./config";

/**
 * Parse OLLAMA_URL — may be a single URL or a comma-separated fallback chain.
 * First successful endpoint wins. Allows e.g.:
 *   OLLAMA_URL=http://192.168.1.198:11434,http://ollama:11434
 * to try a fast MBP-hosted Ollama first and fall back to the slow NAS sidecar
 * when the laptop is asleep / away.
 */
function ollamaEndpoints(): string[] {
  return OLLAMA_URL.split(",")
    .map((u) => u.trim().replace(/\/+$/, ""))
    .filter((u) => u.length > 0);
}

const ENDPOINTS = ollamaEndpoints();
const TIMEOUT_MS = 8000;
// Per-process state: which endpoint succeeded last? Used to "stick" to a known-good
// endpoint until it fails, so we don't pay the failover-probe cost on every call.
let preferredIdx = 0;

interface EmbedResp { embeddings: number[][] }

async function postEmbedTo(url: string, input: string | string[]): Promise<EmbedResp> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${url}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return (await resp.json()) as EmbedResp;
  } finally {
    clearTimeout(timer);
  }
}

/** Try the preferred endpoint, then fall back through the rest on failure. */
async function postEmbedFailover(input: string | string[]): Promise<EmbedResp> {
  if (ENDPOINTS.length === 0) {
    throw new Error("No Ollama endpoint configured");
  }
  const order: number[] = [];
  for (let i = 0; i < ENDPOINTS.length; i++) {
    order.push((preferredIdx + i) % ENDPOINTS.length);
  }

  let lastErr: unknown;
  for (const idx of order) {
    try {
      const data = await postEmbedTo(ENDPOINTS[idx], input);
      if (idx !== preferredIdx) {
        // Stick to the new winner for subsequent calls.
        const prevUrl = ENDPOINTS[preferredIdx];
        preferredIdx = idx;
        console.error(`Ollama endpoint switched: ${prevUrl} → ${ENDPOINTS[idx]}`);
      }
      return data;
    } catch (err) {
      lastErr = err;
      // Try next endpoint
    }
  }
  throw new Error(
    `All Ollama endpoints failed (${ENDPOINTS.length} tried): ${(lastErr as Error)?.message ?? "unknown"}`
  );
}

/** Embed a single text string, returns float array */
export async function embedText(text: string): Promise<number[]> {
  const data = await postEmbedFailover(text);
  return data.embeddings[0];
}

/** Embed a batch of texts, returns array of float arrays */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const data = await postEmbedFailover(texts);
  return data.embeddings;
}

/** Embed many texts with concurrency control and progress reporting */
export async function embedAll(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<number[][]> {
  const results: number[][] = new Array(texts.length);
  let completed = 0;

  // Split into batches
  const batches: { startIdx: number; texts: string[] }[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    batches.push({
      startIdx: i,
      texts: texts.slice(i, i + EMBED_BATCH_SIZE),
    });
  }

  // Process batches with concurrency limit
  let batchIdx = 0;
  const workers = Array.from({ length: Math.min(EMBED_CONCURRENCY, batches.length) }, async () => {
    while (batchIdx < batches.length) {
      const idx = batchIdx++;
      const batch = batches[idx];
      try {
        const embeddings = await embedBatch(batch.texts);
        for (let j = 0; j < embeddings.length; j++) {
          results[batch.startIdx + j] = embeddings[j];
        }
        completed += batch.texts.length;
        onProgress?.(completed, texts.length);
      } catch (err) {
        // Retry once
        try {
          const embeddings = await embedBatch(batch.texts);
          for (let j = 0; j < embeddings.length; j++) {
            results[batch.startIdx + j] = embeddings[j];
          }
          completed += batch.texts.length;
          onProgress?.(completed, texts.length);
        } catch {
          // Skip this batch on second failure
          completed += batch.texts.length;
          onProgress?.(completed, texts.length);
        }
      }
    }
  });

  await Promise.all(workers);
  return results;
}

/** Convert float array to Buffer for sqlite-vec storage */
export function vecToBuffer(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(vec[i], i * 4);
  }
  return buf;
}

/** Convert Buffer back to float array */
export function bufferToVec(buf: Buffer): number[] {
  const vec: number[] = [];
  for (let i = 0; i < buf.length; i += 4) {
    vec.push(buf.readFloatLE(i));
  }
  return vec;
}
