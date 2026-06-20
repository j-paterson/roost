/**
 * NSFW image augmentation for multi-label tag assignments (Wave 2 D1).
 *
 * `augmentNsfwAssignments` is an additive overlay: for each item and each
 * category listed in `nsfwCategories`, it combines the image-classifier score
 * with the text-detector sigmoid score via OR logic (nsfwEnsemble) and —
 * if the ensemble fires — adds that category to the item's `tags` set even
 * when the text detector alone did not fire.
 *
 * This function is intentionally inert by default:
 *   - Called only when `nsfwCategories` is non-empty → zero sidecar calls when
 *     the user has not configured any NSFW categories.
 *   - For items with no resolvable image paths, `classifyNsfwImage([])` returns 0
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
  classifyNsfwImage,
  nsfwEnsemble,
  resolveAttachmentImagePaths,
  type NoteImageInfo,
} from "@/pipeline/nsfw-image-detector";
import type { EmbeddingCacheEntry } from "@/types/roost";

// ── Public opts type ─────────────────────────────────────────────────────────

export interface AugmentNsfwOpts {
  /** Category names that should be treated as NSFW (from settings.nsfwCategories). */
  nsfwCategories: string[];
  /** Loaded tag detectors — needed to look up per-tag thresholds for textThr. */
  det: TagDetectors;
  /** Absolute vault filesystem path (for resolveAttachmentImagePaths). */
  vaultPath: string;
  /**
   * Embedding cache keyed by roostId — used to re-run the per-tag sigmoid
   * forward pass to retrieve the text score for each NSFW category.
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

// ── augmentNsfwAssignments ────────────────────────────────────────────────────

/**
 * Mutate `assignments` in-place: for each item × each nsfwCategory, run the
 * image+text ensemble and add the category tag if it fires even when text alone
 * did not.
 *
 * Calling with `nsfwCategories=[]` is a guaranteed no-op (no image/sidecar
 * calls are made).
 *
 * @param assignments    The Map<id, TagAssignment> returned by scoreWithTagDetectors.
 *                       Modified in-place.
 * @param itemIds        IDs of items to evaluate (typically step0.unsortedIdSet).
 * @param opts           Runtime context (see AugmentNsfwOpts).
 */
export async function augmentNsfwAssignments(
  assignments: Map<string, TagAssignment>,
  itemIds: string[],
  opts: AugmentNsfwOpts,
): Promise<void> {
  const { nsfwCategories, det, vaultPath, embeddingCache, fileIndex, metadataCache, onLog } = opts;

  // Fast-exit: no categories configured → no sidecar calls, no work.
  if (nsfwCategories.length === 0) return;

  const log = onLog ?? (() => {});

  // Build a lookup: category name → index in det.tags (for threshold lookup).
  const tagIndexByName = new Map<string, number>();
  for (let i = 0; i < det.tags.length; i++) {
    tagIndexByName.set(det.tags[i], i);
  }

  // Only process NSFW categories that are actually known to the detector.
  const knownNsfwCats = nsfwCategories.filter(cat => tagIndexByName.has(cat));
  if (knownNsfwCats.length === 0) {
    log(`[nsfw-augment] none of nsfwCategories=${JSON.stringify(nsfwCategories)} found in detector tags — skipping`);
    return;
  }

  let augmented = 0;

  for (const id of itemIds) {
    const ta = assignments.get(id);
    if (!ta) continue; // item had no embedding — skip

    // Skip if all NSFW categories are already in the tag set.
    const missingNsfwCats = knownNsfwCats.filter(cat => !ta.tags.includes(cat));
    if (missingNsfwCats.length === 0) continue;

    // Resolve note image paths.
    const file = fileIndex.get(id);
    const noteInfo = resolveNoteImageInfo(id, file, metadataCache, vaultPath);
    const imagePaths = noteInfo ? resolveAttachmentImagePaths(noteInfo) : [];

    // Get image score (0 when no paths or sidecar down).
    const imageScore = await classifyNsfwImage(imagePaths);

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

    for (const cat of missingNsfwCats) {
      const tagIdx = tagIndexByName.get(cat)!;
      const textThr = det.thresholds[tagIdx];

      // If image score is 0, OR-ensemble can only fire from text. But we
      // already know the tag wasn't in ta.tags (text didn't fire at its
      // threshold). Safe to skip this item×category pair.
      if (imageScore === 0) continue;

      const textScore = sigScores?.get(cat) ?? 0;

      if (nsfwEnsemble(imageScore, textScore, 0.5, textThr)) {
        ta.tags = [...ta.tags, cat];
        augmented++;
        log(
          `[nsfw-augment] ${id}: added "${cat}" ` +
          `(image=${imageScore.toFixed(3)}, text=${textScore.toFixed(3)}, textThr=${textThr.toFixed(3)})`,
        );
      }
    }
  }

  log(`[nsfw-augment] augmented ${augmented} tag slot(s) across ${itemIds.length} items`);
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
