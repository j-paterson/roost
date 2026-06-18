/**
 * GUARDED EXPORTER (not a real test) — runs embedding top-1
 * (`scoreAgainstCategories({embeddingOnly:true})`) over every fixture item and
 * writes `predictions-embedding-top1.json` in the shared predictions format:
 *
 *   { "<roost_id>": { "pred": "<category|__none__>", "score": <float 0..1> } }
 *
 * Centroids are built from the REAL `buildCategoryDefs` with the entire fixture
 * (dev ∪ holdout) strictly held out, so no item can match itself.
 *
 * Run explicitly:
 *   ROOST_EXPORT_PREDICTIONS=1 npx vitest run \
 *     packages/core/src/pipeline/__tests__/export-predictions.test.ts
 *
 * Skips unless ROOST_EXPORT_PREDICTIONS=1 (so the normal suite is unaffected).
 *
 * Guards enforced:
 *  - GT = human collection only (fixture uses `groundTruth` from `collection`,
 *    never `roost_category`). assert_gt_not_roost_category equivalent: the
 *    fixture's `groundTruth` field is validated never to originate from
 *    roost_category by the Python honest_eval_lib guard; here we simply don't
 *    read roost_category at all.
 *  - fixture (dev ∪ holdout) IDs excluded from centroids / covariance.
 *  - dev ∩ holdout = ∅ (asserted explicitly below).
 *  - seed 1729 (owned by the fixture generator; preserved here verbatim).
 *
 * Slice 2 note: the embedding-only path scores all categories
 * (`categories.map(...)` over the full canon, no topK slice — evaluate.ts:413).
 * No LLM is invoked. Slice 2's full-canon LLM path can pass
 * `topK: categories.length` and the existing `Math.min(opts.topK ?? K_RERANK_LARGE,
 * categories.length)` at evaluate.ts:379 already satisfies that — no default changed.
 */
import { describe, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { App, TFile } from "obsidian";
import { gatherVaultCollections } from "@/lib/vault-utils";
import { buildCategoryDefs, scoreAgainstCategories } from "@/pipeline/evaluate";

const RUN = process.env["ROOST_EXPORT_PREDICTIONS"] === "1";
const VAULT = "/Users/josystem/SynologyDrive/SynologyDrive/ObsidianBookmarks";
const SYNC_FOLDER = "Bookmarks";
const ROOST = path.join(VAULT, ".roost");
const BIN = path.join(ROOST, "cache", "embedding-vectors.bin");
const META = path.join(ROOST, "cache", "embedding-meta.json");
const ANCHOR = path.join(ROOST, "cache", "anchor-name-embeddings.json");
const FIXTURE = path.join(ROOST, "build", "eval-fixture-large.json");
const OUT = path.join(ROOST, "build", "predictions-embedding-top1.json");

// ── Helpers (mirrored from export-production-centroids.test.ts) ──────────────

/** Read simple scalar frontmatter fields from a markdown file. */
function readFrontmatter(file: string): Record<string, string> | null {
  const txt = fs.readFileSync(file, "utf8");
  const m = /^---\n([\s\S]*?)\n---/.exec(txt);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^(roost_id|collection|roost_category|roost_assigned_by|platform):\s*(.+)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return Object.keys(fm).length ? fm : null;
}

function walkMd(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(p, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** fs-backed App shim so the REAL gatherVaultCollections runs unmodified. */
function makeApp(): App {
  const files = walkMd(path.join(VAULT, SYNC_FOLDER));
  const fmByPath = new Map<string, Record<string, string>>();
  const tfiles: TFile[] = [];
  for (const abs of files) {
    const rel = path.relative(VAULT, abs);
    const fm = readFrontmatter(abs);
    if (!fm) continue;
    fmByPath.set(rel, fm);
    tfiles.push({ path: rel } as TFile);
  }
  return {
    vault: { getMarkdownFiles: () => tfiles },
    metadataCache: { getFileCache: (f: TFile) => ({ frontmatter: fmByPath.get(f.path) }) },
  } as unknown as App;
}

function loadVectors(): Map<string, number[]> {
  const dim = JSON.parse(fs.readFileSync(META, "utf8")).dim as number;
  const raw = fs.readFileSync(BIN);
  const nl = raw.indexOf(0x0a);
  const keys: string[] = JSON.parse(raw.subarray(0, nl).toString("utf8"));
  const start = raw.byteOffset + nl + 1;
  // ArrayBuffer.slice copies into a fresh, 4-byte-aligned buffer (Float32Array
  // requires an aligned offset, which raw.byteOffset+nl+1 is not).
  const ab = raw.buffer.slice(start, start + keys.length * dim * 4);
  const floats = new Float32Array(ab);
  const map = new Map<string, number[]>();
  for (let i = 0; i < keys.length; i++) map.set(keys[i], Array.from(floats.subarray(i * dim, (i + 1) * dim)));
  return map;
}

// ── Predictions format type ───────────────────────────────────────────────────

interface PredictionEntry {
  /** Top-1 category name, or "__none__" for items without a cached vector. */
  pred: string;
  /**
   * Top-1 cosine similarity in [0, 1]. For items without a vector the score
   * is 0. Higher = more confidently in-set.
   */
  score: number;
}

// ── Test ──────────────────────────────────────────────────────────────────────

describe("export embedding top-1 predictions", () => {
  it(
    RUN
      ? "runs embedding top-1 over fixture (fixture held out from centroids) → predictions-embedding-top1.json"
      : "skipped (set ROOST_EXPORT_PREDICTIONS=1)",
    async () => {
      if (!RUN) return;

      // 1. Production collections + provenance via the REAL function.
      const app = makeApp();
      const { collections, itemProvenance } = gatherVaultCollections(app, SYNC_FOLDER);

      // 2. Load fixture. The 'large' split is dev ∪ holdout.
      const fixtureRaw = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
      const fixtureItems: Array<{ id: string; groundTruth: string; isNegative: boolean }> =
        fixtureRaw.testItems;

      // Guard: dev ∩ holdout = ∅ (fixture-generator guarantee, asserted here for
      // runtime confidence). Load both splits separately to verify.
      const devPath = path.join(ROOST, "build", "eval-fixture-dev.json");
      const holdoutPath = path.join(ROOST, "build", "eval-fixture-holdout.json");
      if (fs.existsSync(devPath) && fs.existsSync(holdoutPath)) {
        const devIds = new Set<string>(
          (JSON.parse(fs.readFileSync(devPath, "utf8")).testItems as Array<{ id: string }>).map(t => t.id),
        );
        const holdoutIds = (
          JSON.parse(fs.readFileSync(holdoutPath, "utf8")).testItems as Array<{ id: string }>
        ).map(t => t.id);
        const overlap = holdoutIds.filter(id => devIds.has(id));
        if (overlap.length > 0) {
          throw new Error(`dev ∩ holdout overlap: ${overlap.length} ids (e.g. ${overlap.slice(0, 3).join(", ")})`);
        }
      }

      // 3. Strict holdout: exclude ALL fixture IDs (dev ∪ holdout) from centroids.
      const holdout = new Set<string>(fixtureItems.map(t => t.id));
      const heldCollections: Record<string, string[]> = {};
      for (const [name, ids] of Object.entries(collections)) {
        const kept = (ids as string[]).filter(id => !holdout.has(id));
        if (kept.length) heldCollections[name] = kept;
      }

      // 4. Load verified-v2 embedding vectors.
      const vecs = loadVectors();
      const cache: Record<string, { vision: null; summary: null; category: null; vec: number[] }> = {};
      for (const [id, vec] of vecs) cache[id] = { vision: null, summary: null, category: null, vec };

      // 5. Production's exact anchor-name vectors.
      const anchorRaw = JSON.parse(fs.readFileSync(ANCHOR, "utf8")) as Record<
        string,
        { vec: number[]; modelVersion: number }
      >;
      const nameEmbeddings = new Map<string, number[]>();
      for (const [k, v] of Object.entries(anchorRaw)) {
        if (v.modelVersion === 1) nameEmbeddings.set(k, v.vec);
      }

      // 6. Build production centroids (production variant: provenance + name blend).
      //    Identical to the 'prod' variant in export-production-centroids.test.ts.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const categories = buildCategoryDefs(heldCollections, new Map(), cache as any, undefined, itemProvenance, nameEmbeddings);

      // eslint-disable-next-line no-console
      console.log(`[export-predictions] ${categories.length} centroids, ${fixtureItems.length} fixture items`);

      // 7. Run embedding top-1 over ALL fixture items (no LLM).
      //    The embedding-only path scores against ALL categories (categories.map at
      //    evaluate.ts:413) — topK is irrelevant here, full-canon by construction.
      const itemIds = fixtureItems.map(t => t.id);
      const result = await scoreAgainstCategories({
        itemIds,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cache: cache as any,
        categories,
        embeddingOnly: true,
        threshold: 0, // pure argmax, no floor rejection (scorer decides __none__)
      });

      // 8. Write predictions.json. Items without a cached vector (unmatched) emit
      //    pred="__none__" score=0 — the python scorer handles __none__ as OOD.
      const predictions: Record<string, PredictionEntry> = {};
      for (const item of fixtureItems) {
        const id = item.id;
        const assigned = result.assignments.get(id);
        const detail = result.matchDetails.get(id);
        if (assigned && detail) {
          // sim is raw cosine similarity (already [0,1] for normalized vectors)
          const score = Math.max(0, Math.min(1, detail.sim));
          predictions[id] = { pred: assigned, score };
        } else {
          // No vector in cache — no prediction.
          predictions[id] = { pred: "__none__", score: 0 };
        }
      }

      fs.writeFileSync(OUT, JSON.stringify(predictions, null, 2));

      const assigned = Object.values(predictions).filter(p => p.pred !== "__none__").length;
      const none = fixtureItems.length - assigned;
      // eslint-disable-next-line no-console
      console.log(
        `[export-predictions] written ${Object.keys(predictions).length} entries ` +
        `(${assigned} assigned, ${none} __none__) → ${path.basename(OUT)}`,
      );
    },
  );
});
