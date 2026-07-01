import { requestUrl } from "obsidian";
import { EMBED_URL, EMBED_STAGE_TIMEOUT_MS } from "@/config";
import type { ClassifierHeadData, MetaHeadData } from "@/pipeline/classifier-head";
import type { TrainingRow } from "@/pipeline/train-head";

export interface StackedHeadsData {
  text: ClassifierHeadData;
  vision: ClassifierHeadData;
  meta: MetaHeadData;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const to = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("train-heads timed out")), ms); });
  return Promise.race([p, to]).finally(() => clearTimeout(t)) as Promise<T>;
}

function isHead(h: unknown): h is ClassifierHeadData {
  const o = h as ClassifierHeadData;
  return !!o && Array.isArray(o.classes) && Array.isArray(o.W) && Array.isArray(o.b);
}

/** Train stacked heads in the Python sidecar. Sends only row id+category (the
 *  sidecar loads vectors from the on-disk bins). Returns null on ANY failure so
 *  the caller skips the retrain rather than blocking. */
export async function trainStackedHeadsViaSidecar(
  rows: TrainingRow[],
  oofFolds: number,
): Promise<StackedHeadsData | null> {
  try {
    const res = await withTimeout(requestUrl({
      url: `${EMBED_URL}/api/train-heads`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: rows.map((r) => ({ id: r.id, category: r.category })), oofFolds }),
      throw: false,
    }), EMBED_STAGE_TIMEOUT_MS);
    if (res.status < 200 || res.status >= 300) return null;
    const j = res.json as Partial<StackedHeadsData> | undefined;
    if (!j || !isHead(j.text) || !isHead(j.vision) || !isHead(j.meta as unknown)) return null;
    return j as StackedHeadsData;
  } catch {
    return null;
  }
}
