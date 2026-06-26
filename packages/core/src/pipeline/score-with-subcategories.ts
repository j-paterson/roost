/**
 * scoreWithSubcategories — two-pass scoring wrapper above scoreAgainstCategories.
 *
 * Pass 1: T1+T2 ensemble against top-level categories (unchanged production behavior).
 * Pass 2 (per parent): T1-NONE against parent's subcategories. On "N" → item stays
 *   at parent (subcategory: null). Items in parents with no subcategories skip pass 2.
 *
 * Used by smart-assign on the unsorted folder so the user sees a 3-level proposal
 * tree (top-level → subcategory → items) in a single staging pass.
 */
import { scoreAgainstCategories } from "@/pipeline/evaluate";
import type { CategoryDef } from "@/pipeline/evaluate";
import type { ClassifierHead, StackedHeads } from "@/pipeline/classifier-head";
import type { EmbeddingCacheEntry, MatchDetail } from "@/types/roost";
import type { Vault } from "obsidian";
import type { StopSignal } from "@/types/sync";

export interface ScoreWithSubcategoriesOpts {
  itemIds: string[];
  cache: Record<string, EmbeddingCacheEntry>;
  topLevelCategories: CategoryDef[];
  /** subcatsByParent[parentName] = list of subcategory CategoryDefs for that parent.
   *  Parents with no entry (or empty array) skip pass 2 — items stay at top-level only. */
  subcatsByParent: Map<string, CategoryDef[]>;
  vault?: Vault;
  /** Top-level floor passed to pass 1's scoreAgainstCategories. */
  threshold?: number;
  /** Subcategory floor passed to pass 2's scoreAgainstCategories. Defaults to 0.55 per the v2 eval. */
  subcatThreshold?: number;
  ollamaUrl?: string;
  onProgress?: (done: number, total: number) => void;
  onLog?: (msg: string) => void;
  stopSignal?: StopSignal;
  concurrency?: number;
  /** CLIP fusion strength passed through to both scoreAgainstCategories passes.
   *  0 = text only, 1 = CLIP only. Defaults to DEFAULT_CLIP_FUSION_ALPHA (0.5). */
  clipFusionAlpha?: number;
  /** When true, the TOP-LEVEL pass (pass 1) uses embedding top-1 (no LLM rerank) —
   *  the validated honest-label win. Pass 2 (subcategory) is left LLM-based
   *  (unvalidated for subcats). */
  embeddingOnly?: boolean;
  /** Trained single classifier head for pass 1 (top-level). Forwarded to
   *  scoreAgainstCategories, which uses it only when its classes match the live
   *  categories; null → nearest-centroid. */
  classifierHead?: ClassifierHead | null;
  /** Stacked heads (text + vision + meta) for pass 1 (top-level). Takes precedence
   *  over classifierHead when present and class-matching. Pass 2 (subcategories) never
   *  uses heads — subcats are not in the head's class set. */
  stackedHeads?: StackedHeads | null;
}

export interface ScoreWithSubcategoriesResult {
  /** itemId → { parent, subcategory: string | null }. Items unmatched at top-level are absent. */
  assignments: Map<string, { parent: string; subcategory: string | null }>;
  /** Items that didn't fit any top-level category (mirrors scoreAgainstCategories.unmatched). */
  unmatched: string[];
  /** Top-level match details (subcategory pick is captured in `assignments`). */
  matchDetails: Map<string, MatchDetail>;
}

export async function scoreWithSubcategories(
  opts: ScoreWithSubcategoriesOpts,
): Promise<ScoreWithSubcategoriesResult> {
  const {
    itemIds, cache, topLevelCategories, subcatsByParent,
    vault, threshold, subcatThreshold, ollamaUrl, onProgress, onLog, stopSignal, concurrency,
    clipFusionAlpha, embeddingOnly, classifierHead, stackedHeads,
  } = opts;

  // Total work: pass 1 = N items + pass 2 = up to N more (depends on pass-1 routing).
  // Use 2 * itemIds.length as the total; progress lands exactly on total at completion.
  const total = 2 * itemIds.length;
  let done = 0;
  const reportProgress = () => onProgress?.(done, total);

  // Pass 1: top-level scoring.
  const pass1 = await scoreAgainstCategories({
    itemIds, cache, categories: topLevelCategories, vault,
    threshold, ollamaUrl, onLog, stopSignal, concurrency,
    clipFusionAlpha, embeddingOnly, classifierHead, stackedHeads,
    onProgress: (d) => { done = d; reportProgress(); },
  });

  if (stopSignal?.stopped) {
    const assignments = new Map<string, { parent: string; subcategory: string | null }>();
    for (const [id, parent] of pass1.assignments) assignments.set(id, { parent, subcategory: null });
    return { assignments, unmatched: pass1.unmatched, matchDetails: pass1.matchDetails };
  }

  // Group pass-1 assignments by parent for pass 2.
  const itemsByParent = new Map<string, string[]>();
  for (const [itemId, parent] of pass1.assignments) {
    let bucket = itemsByParent.get(parent);
    if (!bucket) { bucket = []; itemsByParent.set(parent, bucket); }
    bucket.push(itemId);
  }

  // Pass 2: per-parent subcategory scoring (skip parents with 0 subcats).
  const subcatAssignments = new Map<string, string | null>();
  let pass2BaseDone = itemIds.length;
  let pass2InflightDone = 0;

  for (const [parent, parentItems] of itemsByParent) {
    if (stopSignal?.stopped) {
      for (const id of parentItems) subcatAssignments.set(id, null);
      continue;
    }
    const parentSubcats = subcatsByParent.get(parent);
    if (!parentSubcats || parentSubcats.length === 0) {
      for (const id of parentItems) subcatAssignments.set(id, null);
      pass2InflightDone += parentItems.length;
      done = pass2BaseDone + pass2InflightDone;
      reportProgress();
      continue;
    }

    const pass2 = await scoreAgainstCategories({
      itemIds: parentItems, cache, categories: parentSubcats, vault,
      threshold: subcatThreshold ?? 0.55,
      noneRefusal: true,
      ollamaUrl, onLog, stopSignal, concurrency,
      clipFusionAlpha,
      onProgress: (d) => {
        done = pass2BaseDone + pass2InflightDone + d;
        reportProgress();
      },
    });

    for (const id of parentItems) {
      const subcat = pass2.assignments.get(id);
      subcatAssignments.set(id, subcat ?? null);
    }
    pass2InflightDone += parentItems.length;
  }

  // Final progress tick — ensure we land exactly on total.
  done = total;
  reportProgress();

  // Merge: build the final assignments map.
  const assignments = new Map<string, { parent: string; subcategory: string | null }>();
  for (const [id, parent] of pass1.assignments) {
    assignments.set(id, { parent, subcategory: subcatAssignments.get(id) ?? null });
  }

  return { assignments, unmatched: pass1.unmatched, matchDetails: pass1.matchDetails };
}
