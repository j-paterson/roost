/**
 * GUARDED EXPORTER (not a real test) — runs the LLM-NONE rejection path
 * (`scoreAgainstCategories({embeddingOnly:false, noneRefusal:true})`) over every
 * HOLDOUT fixture item and writes `predictions-llm-none.json` in the shared
 * predictions format:
 *
 *   { "<roost_id>": { "pred": "<category|__none__>", "score": <float 0..1> } }
 *
 * This is M4 (LLM-librarian NONE rejection) in the pre-registered method matrix.
 * The scorer called is the REAL production `scoreAgainstCategories` with the
 * T1-NONE prompt path (evaluate.ts:510) — no reimplementation.
 *
 * Centroids are built from the REAL `buildCategoryDefs` with the entire fixture
 * (dev ∪ holdout) strictly held out, so no item can match itself.
 *
 * Run explicitly:
 *   ROOST_EXPORT_LLM_PREDICTIONS=1 npx vitest run \
 *     packages/core/src/pipeline/__tests__/export-predictions-llm.test.ts
 *
 * Skips unless ROOST_EXPORT_LLM_PREDICTIONS=1 (so the normal suite is unaffected).
 *
 * Predictions format:
 *   pred  = the picked category name (string), or "__none__" when the scorer
 *           abstains (LLM returned "N", parse failure, or sim-floor rejection).
 *   score = the picked centroid cosine similarity in [0,1] for assigned items;
 *           0.0 for __none__ (abstention reads as strong rejection signal).
 *
 * Guards enforced:
 *  - GT = human collection only (fixture uses `groundTruth` from `collection`,
 *    never `roost_category`). assert_gt_not_roost_category equivalent: the
 *    fixture's `groundTruth` field is validated by the Python honest_eval_lib
 *    guard; here we simply never read roost_category.
 *  - fixture (dev ∪ holdout) IDs excluded from centroids / covariance.
 *  - dev ∩ holdout = ∅ (asserted explicitly below).
 *  - seed 1729 (owned by the fixture generator; preserved verbatim).
 *
 * Score cache: the LLM scorer writes a score cache to .roost/cache/score-cache.json
 * so subsequent partial runs skip already-scored items. Smoke-test with one item
 * before the full ~4,320-item run (use caffeinate; budget ~4+ hours wall clock).
 */
import { describe, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { App, TFile } from "obsidian";
import { FileSystemAdapter, Vault, __setRequestUrlImpl } from "obsidian";
import { gatherVaultCollections } from "@/lib/vault-utils";
import { buildCategoryDefs, scoreAgainstCategories } from "@/pipeline/evaluate";

const RUN = process.env["ROOST_EXPORT_LLM_PREDICTIONS"] === "1";
const VAULT = "/Users/josystem/SynologyDrive/SynologyDrive/ObsidianBookmarks";
const SYNC_FOLDER = "Bookmarks";
const ROOST = path.join(VAULT, ".roost");
const BIN = path.join(ROOST, "cache", "embedding-vectors.bin");
const META = path.join(ROOST, "cache", "embedding-meta.json");
const ANCHOR = path.join(ROOST, "cache", "anchor-name-embeddings.json");
const FIXTURE_LARGE = path.join(ROOST, "build", "eval-fixture-large.json");
const FIXTURE_DEV = path.join(ROOST, "build", "eval-fixture-dev.json");
const FIXTURE_HOLDOUT = path.join(ROOST, "build", "eval-fixture-holdout.json");
const OUT = path.join(ROOST, "build", "predictions-llm-none.json");

// ── Helpers (mirrored from export-predictions.test.ts) ───────────────────────

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

/**
 * Build a minimal Vault shim that lets loadScoreCache resolve the vault base
 * path to the real vault so the LLM score cache is persisted across runs.
 * Uses the FileSystemAdapter mock class from obsidian shim; production code
 * checks `vault.adapter instanceof FileSystemAdapter`.
 */
function makeVault(): Vault {
  const adapter = new FileSystemAdapter();
  adapter.basePath = VAULT;
  const vault = new Vault() as Vault & { adapter: FileSystemAdapter };
  vault.adapter = adapter;
  return vault;
}

// ── Predictions format type ───────────────────────────────────────────────────

interface PredictionEntry {
  /**
   * Top-1 category name picked by the T1-NONE LLM call, or "__none__" when
   * the scorer abstains (LLM returned "N", parse failure, or sim-floor rejection).
   */
  pred: string;
  /**
   * Picked centroid cosine similarity in [0, 1] for assigned items.
   * 0.0 for __none__ — abstention reads as strong OOD rejection signal.
   */
  score: number;
}

// ── Test ──────────────────────────────────────────────────────────────────────

describe("export LLM-NONE predictions (M4)", () => {
  it(
    RUN
      ? "runs T1-NONE over holdout fixture (fixture held out from centroids) → predictions-llm-none.json"
      : "skipped (set ROOST_EXPORT_LLM_PREDICTIONS=1)",
    async () => {
      if (!RUN) return;

      // 1. Production collections + provenance via the REAL function.
      const app = makeApp();
      const { collections, itemProvenance } = gatherVaultCollections(app, SYNC_FOLDER);

      // 2. Load fixture. The 'large' split is dev ∪ holdout; used to build the
      //    holdout set for centroid exclusion.
      const fixtureRaw = JSON.parse(fs.readFileSync(FIXTURE_LARGE, "utf8"));
      const allFixtureItems: Array<{ id: string; groundTruth: string; isNegative: boolean }> =
        fixtureRaw.testItems;

      // Guard: dev ∩ holdout = ∅ (fixture-generator guarantee, asserted here for
      // runtime confidence).
      if (fs.existsSync(FIXTURE_DEV) && fs.existsSync(FIXTURE_HOLDOUT)) {
        const devIds = new Set<string>(
          (JSON.parse(fs.readFileSync(FIXTURE_DEV, "utf8")).testItems as Array<{ id: string }>).map(t => t.id),
        );
        const holdoutIds = (
          JSON.parse(fs.readFileSync(FIXTURE_HOLDOUT, "utf8")).testItems as Array<{ id: string }>
        ).map(t => t.id);
        const overlap = holdoutIds.filter(id => devIds.has(id));
        if (overlap.length > 0) {
          throw new Error(`dev ∩ holdout overlap: ${overlap.length} ids (e.g. ${overlap.slice(0, 3).join(", ")})`);
        }
      }

      // 3. Strict holdout: exclude ALL fixture IDs (dev ∪ holdout) from centroids.
      //    This is the contamination guard — no fixture item can match itself.
      const fixtureIdSet = new Set<string>(allFixtureItems.map(t => t.id));
      const heldCollections: Record<string, string[]> = {};
      for (const [name, ids] of Object.entries(collections)) {
        const kept = (ids as string[]).filter(id => !fixtureIdSet.has(id));
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
      console.log(`[export-predictions-llm] ${categories.length} centroids, ${allFixtureItems.length} total fixture items`);

      if (categories.length === 0) {
        throw new Error(
          "[export-predictions-llm] 0 centroids after fixture holdout — " +
          "the fixture covers 100% of honest-collection members. This is the " +
          "known M4 crash condition. Use production centroids that include " +
          "auto-categorized items (roost_category members) which survive holdout.",
        );
      }

      // 7. Load only the HOLDOUT split for scoring.
      //    Per spec: dev split is for tuning; holdout for the final report.
      const holdoutRaw = JSON.parse(fs.readFileSync(FIXTURE_HOLDOUT, "utf8"));
      const holdoutItems: Array<{ id: string; groundTruth: string; isNegative: boolean }> =
        holdoutRaw.testItems;

      // eslint-disable-next-line no-console
      console.log(`[export-predictions-llm] scoring ${holdoutItems.length} holdout items via T1-NONE`);

      // 8. Wire real HTTP so the LLM requestUrl calls reach the live Ollama instance.
      //    The obsidian mock's requestUrl is a stub that throws unless __setRequestUrlImpl
      //    is called. We delegate to native fetch so no interceptor sits in between.
      __setRequestUrlImpl(async (req) => {
        const res = await fetch(req.url, {
          method: req.method ?? "POST",
          headers: req.headers,
          body: req.body,
        });
        const text = await res.text();
        let json: unknown;
        try { json = JSON.parse(text); } catch { json = null; }
        return { status: res.status, headers: Object.fromEntries(res.headers.entries()), json, text, arrayBuffer: new ArrayBuffer(0) };
      });

      // 8b. Build a minimal vault shim so the score cache is persisted across runs.
      //    The LLM scorer reads/writes .roost/cache/score-cache.json via the vault
      //    adapter's base path. Resuming a partial run skips already-scored items.
      const vault = makeVault();

      // 9. Run the REAL T1-NONE path over holdout items.
      //    embeddingOnly: false — invoke the LLM.
      //    noneRefusal: true  — T1-NONE prompt (evaluate.ts:510); LLM may return "N".
      //    threshold: 0       — no sim-floor rejection; pure LLM-NONE signal.
      //    topK: categories.length — score against all categories (full canon,
      //    position-bias-safe). The scorer clips to min(topK, K=5) for T1-NONE.
      const itemIds = holdoutItems.map(t => t.id);
      const result = await scoreAgainstCategories({
        itemIds,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cache: cache as any,
        categories,
        vault,
        embeddingOnly: false,
        noneRefusal: true,
        threshold: 0,
        topK: categories.length,
        onLog: (msg) => { console.log(msg); }, // eslint-disable-line no-console
        onProgress: (done, total) => {
          if (done % 100 === 0 || done === total) {
            // eslint-disable-next-line no-console
            console.log(`[export-predictions-llm] progress: ${done}/${total}`);
          }
        },
      });

      // 10. Write predictions-llm-none.json.
      //     Assigned items: pred = category name, score = centroid sim in [0,1].
      //     Unmatched items (NONE abstention, parse fail, sim-floor rejection):
      //       pred = "__none__", score = 0.0.
      const predictions: Record<string, PredictionEntry> = {};
      for (const item of holdoutItems) {
        const id = item.id;
        const assigned = result.assignments.get(id);
        const detail = result.matchDetails.get(id);
        if (assigned && detail) {
          const score = Math.max(0, Math.min(1, detail.sim));
          predictions[id] = { pred: assigned, score };
        } else {
          // Unmatched: LLM returned "N", parse failure, or sim-floor rejection.
          // score = 0.0 so the python scorer sees a strong rejection signal.
          predictions[id] = { pred: "__none__", score: 0.0 };
        }
      }

      fs.writeFileSync(OUT, JSON.stringify(predictions, null, 2));

      const assigned = Object.values(predictions).filter(p => p.pred !== "__none__").length;
      const none = holdoutItems.length - assigned;
      const noneRate = (none / holdoutItems.length * 100).toFixed(1);
      // eslint-disable-next-line no-console
      console.log(
        `[export-predictions-llm] written ${Object.keys(predictions).length} entries ` +
        `(${assigned} assigned, ${none} __none__ / ${noneRate}%) → ${path.basename(OUT)}`,
      );
    },
    // LLM run timeout: up to 8 hours for ~4,320 items. The score cache means
    // re-runs are fast. For a one-item smoke-test this resolves in seconds.
    8 * 60 * 60 * 1000,
  );
});
