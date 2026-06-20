/**
 * Uncensored content image augmentation for multi-label tag assignments (Wave 2 D1).
 *
 * `augmentUncensoredAssignments` is an additive overlay: for each item and each
 * category listed in `uncensoredCategories`, it combines the image-classifier score
 * with the text-detector sigmoid score via OR logic (uncensoredEnsemble) and —
 * if the ensemble fires — adds that category to the item's `tags` set even
 * when the text detector alone did not fire.
 *
 * This function exists because cloud LLMs refuse explicit/uncensored content;
 * the local image-classifier path is censorship-resistant by design.
 *
 * This function is intentionally inert by default:
 *   - Called only when `uncensoredCategories` is non-empty → zero sidecar calls when
 *     the user has not configured any uncensored categories.
 *   - For items with no resolvable image paths, `classifyUncensoredImage([])` returns 0
 *     immediately without hitting the network.
 *
 * Integration point: call AFTER `scoreWithTagDetectors` and BEFORE storing the
 * map, passing the same `Map<id, TagAssignment>` for in-place mutation.
 */

import type { MetadataCache, TFile } from "obsidian";
import type { TagAssignment } from "@/pipeline/evaluate";
import type { TagDetectors } from "@/pipeline/tag-detectors";
import { classifyTags } from "@/pipeline/tag-detectors";
import {
  classifyUncensoredImage,
  uncensoredEnsemble,
  resolveAttachmentImagePaths,
  type NoteImageInfo,
} from "@/pipeline/uncensored-image-detector";
import type { EmbeddingCacheEntry } from "@/types/roost";

// ── Public opts type ─────────────────────────────────────────────────────────

export interface AugmentUncensoredOpts {
  /** Category names that should be treated as uncensored (from settings.uncensoredCategories). */
  uncensoredCategories: string[];
  /** Loaded tag detectors — needed to look up per-tag thresholds for textThr. */
  det: TagDetectors;
  /** Absolute vault filesystem path (for resolveAttachmentImagePaths). */
  vaultPath: string;
  /**
   * Embedding cache keyed by roostId — used to re-run the per-tag sigmoid
   * forward pass to retrieve the text score for each uncensored category.
   * This is the same cache object returned by loadEmbeddingCache in step0.
   */
  embeddingCache: Record<string, EmbeddingCacheEntry>;
  /** Pre-built Map<roostId, TFile> (from buildFileIndex). */
  fileIndex: Map<string, TFile>;
  /** Obsidian MetadataCache — used to read per-file frontmatter (cover field). */
  metadataCache: MetadataCache;
  /** Optional logger. */
  onLog?: (msg: string) => void;
}

// ── augmentUncensoredAssignments ──────────────────────────────────────────────

/**
 * Mutate `assignments` in-place: for each item × each uncensoredCategory, run the
 * image+text ensemble and add the category tag if it fires even when text alone
 * did not.
 *
 * Calling with `uncensoredCategories=[]` is a guaranteed no-op (no image/sidecar
 * calls are made).
 *
 * @param assignments    The Map<id, TagAssignment> returned by scoreWithTagDetectors.
 *                       Modified in-place.
 * @param itemIds        IDs of items to evaluate (typically step0.unsortedIdSet).
 * @param opts           Runtime context (see AugmentUncensoredOpts).
 */
export async function augmentUncensoredAssignments(
  assignments: Map<string, TagAssignment>,
  itemIds: string[],
  opts: AugmentUncensoredOpts,
): Promise<void> {
  const { uncensoredCategories, det, vaultPath, embeddingCache, fileIndex, metadataCache, onLog } = opts;

  // Fast-exit: no categories configured → no sidecar calls, no work.
  if (uncensoredCategories.length === 0) return;

  const log = onLog ?? (() => {});

  // Build a lookup: category name → index in det.tags (for threshold lookup).
  const tagIndexByName = new Map<string, number>();
  for (let i = 0; i < det.tags.length; i++) {
    tagIndexByName.set(det.tags[i], i);
  }

  // Only process uncensored categories that are actually known to the detector.
  const knownUncensoredCats = uncensoredCategories.filter(cat => tagIndexByName.has(cat));
  if (knownUncensoredCats.length === 0) {
    log(`[uncensored-augment] none of uncensoredCategories=${JSON.stringify(uncensoredCategories)} found in detector tags — skipping`);
    return;
  }

  let augmented = 0;

  for (const id of itemIds) {
    const ta = assignments.get(id);
    if (!ta) continue; // item had no embedding — skip

    // Skip if all uncensored categories are already in the tag set.
    const missingUncensoredCats = knownUncensoredCats.filter(cat => !ta.tags.includes(cat));
    if (missingUncensoredCats.length === 0) continue;

    // Resolve note image paths.
    const file = fileIndex.get(id);
    const noteInfo = resolveNoteImageInfo(id, file, metadataCache, vaultPath);
    const imagePaths = noteInfo ? resolveAttachmentImagePaths(noteInfo) : [];

    // Get image score (0 when no paths or sidecar down).
    const imageScore = await classifyUncensoredImage(imagePaths);

    // Get per-tag sigmoid scores for this item. Re-running classifyTags is
    // cheap (pure math, no I/O) — we only do it when imageScore > 0 to avoid
    // unnecessary computation for items with no images.
    let sigScores: Map<string, number> | null = null;
    if (imageScore > 0) {
      const cacheEntry = embeddingCache[id];
      if (cacheEntry?.vec) {
        const result = classifyTags(cacheEntry.vec, det);
        sigScores = new Map(result.scores.map(s => [s.tag, s.score]));
      }
    }

    for (const cat of missingUncensoredCats) {
      const tagIdx = tagIndexByName.get(cat)!;
      const textThr = det.thresholds[tagIdx];

      // If image score is 0, OR-ensemble can only fire from text. But we
      // already know the tag wasn't in ta.tags (text didn't fire at its
      // threshold). Safe to skip this item×category pair.
      if (imageScore === 0) continue;

      const textScore = sigScores?.get(cat) ?? 0;

      if (uncensoredEnsemble(imageScore, textScore, 0.5, textThr)) {
        ta.tags = [...ta.tags, cat];
        augmented++;
        log(
          `[uncensored-augment] ${id}: added "${cat}" ` +
          `(image=${imageScore.toFixed(3)}, text=${textScore.toFixed(3)}, textThr=${textThr.toFixed(3)})`,
        );
      }
    }
  }

  log(`[uncensored-augment] augmented ${augmented} tag slot(s) across ${itemIds.length} items`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build NoteImageInfo for an item from its vault TFile + metadata.
 * Returns null when the file is not found (item has no vault file yet).
 */
function resolveNoteImageInfo(
  roostId: string,
  file: TFile | undefined,
  metadataCache: MetadataCache,
  vaultPath: string,
): NoteImageInfo | null {
  if (!file) return null;
  const fm = metadataCache.getFileCache(file)?.frontmatter;
  const cover = typeof fm?.cover === "string" ? fm.cover : undefined;
  return {
    vaultPath,
    notePath: file.path,
    roostId,
    cover,
  };
}
