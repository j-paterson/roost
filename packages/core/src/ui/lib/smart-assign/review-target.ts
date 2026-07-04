/**
 * Gather items from the unsorted / "Other" pool and compute real-category
 * proposals from a trained classifier head.
 *
 * Used by "Roost: Review 'Other' / unsorted items" to feed the training-review
 * pass with items that have never been filed (unsorted) or were placed in the
 * reserved "Other" holding bucket. Ranking ascending by confidence surfaces
 * the most ambiguous items first — the highest-value signal for the retrainer.
 *
 * Note on head=null (not yet trained): ids are still returned so the command
 * degrades gracefully (review pass shows items without pre-proposals). The
 * proposalMap is empty and the caller should not assume any proposal exists.
 */

import type { App } from "obsidian";
import { ASSIGNED_BY_FIELD, CATEGORY_FIELD, RESERVED_NON_CATEGORIES } from "@/config";
import { softmaxProba, type ClassifierHead } from "@/pipeline/classifier-head";
import type { EmbeddingCacheEntry } from "@/types/roost";

/** Which pool of items to gather. */
export type ReviewTargetMode = "unsorted" | "other" | "both";

/**
 * Gather items from the unsorted / "Other" pool, compute per-item proposals,
 * and rank by ascending classifier confidence (least confident first).
 *
 * @param app        Obsidian App — provides vault file list + metadataCache.
 * @param syncFolder Root folder for sync'd bookmarks (e.g. "Bookmarks").
 * @param target     Which pool: "unsorted" (no roost_category), "other"
 *                   (roost_category lowercases to "other"), or "both" (union).
 * @param cache      Pre-loaded embedding cache (roostId → EmbeddingCacheEntry).
 *                   Items without a `.vec` are silently excluded.
 * @param head       Trained classifier head, or null when not yet trained.
 *
 * @returns
 *   ids         – Matching roost_ids sorted ascending by confidence.
 *                 When head is null the order is vault iteration order.
 *   proposalMap – roostId → predicted (non-reserved) category name.
 *                 Empty when head is null.
 */
export function gatherReviewTargets(
  app: App,
  syncFolder: string,
  target: ReviewTargetMode,
  cache: Record<string, EmbeddingCacheEntry>,
  head: ClassifierHead | null,
): { ids: string[]; proposalMap: Record<string, string> } {
  const files = app.vault
    .getMarkdownFiles()
    .filter(f => f.path.startsWith(syncFolder + "/"));

  const proposalMap: Record<string, string> = {};
  const confidenceMap = new Map<string, number>();
  const collectedIds: string[] = [];

  for (const file of files) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm?.roost_id) continue;

    const id = fm.roost_id as string;

    // Normalise roost_category: absent / empty / sentinel strings → null (unsorted).
    const rawCat = (fm[CATEGORY_FIELD] as string | undefined)?.trim();
    const cat =
      !rawCat || rawCat === "undefined" || rawCat === "null" ? null : rawCat;

    const isUnsorted = cat === null;
    const isOther = cat !== null && cat.toLowerCase() === "other";
    // A human-assigned "Other" means the user already decided — skip it so it does
    // not loop back into the review queue after the first assignment.
    const isHumanJudgedOther = isOther && (fm[ASSIGNED_BY_FIELD] as string | undefined) === "human";

    const matches =
      (target === "unsorted" && isUnsorted) ||
      (target === "other" && isOther && !isHumanJudgedOther) ||
      (target === "both" && (isUnsorted || (isOther && !isHumanJudgedOther)));

    if (!matches) continue;

    // Require a cached embedding vector — items that haven't been embedded yet
    // are excluded so the review pass only shows scored items.
    const vec = cache[id]?.vec;
    if (!vec) continue;

    if (head !== null) {
      // Compute full softmax so we can pick the best *non-reserved* class.
      // The deployed head may include "Other" as a class; proposing "Other" is
      // useless (the item is already in that bucket), so we skip reserved names.
      const proba = softmaxProba(vec, head);
      let bestIdx = -1;
      let bestP = -1;
      for (let c = 0; c < head.classes.length; c++) {
        if (!RESERVED_NON_CATEGORIES.has(head.classes[c].toLowerCase()) && proba[c] > bestP) {
          bestP = proba[c];
          bestIdx = c;
        }
      }
      if (bestIdx < 0) bestIdx = 0; // pathological: all classes reserved — use argmax as fallback
      proposalMap[id] = head.classes[bestIdx];
      confidenceMap.set(id, proba[bestIdx]);
    } else {
      // No head yet — still include the item but record a neutral confidence
      // so the item participates in the review pass without a proposal.
      confidenceMap.set(id, 0);
    }

    collectedIds.push(id);
  }

  // Sort ascending by confidence (least confident = most uncertain = highest
  // training value reviewed first).
  collectedIds.sort(
    (a, b) => (confidenceMap.get(a) ?? 0) - (confidenceMap.get(b) ?? 0) || a.localeCompare(b),
  );

  return { ids: collectedIds, proposalMap };
}
