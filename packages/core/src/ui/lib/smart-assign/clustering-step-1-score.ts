import type { StopSignal } from "@/types/sync";
import type { MatchDetail } from "@/types/roost";
import type { AssignedBy } from "@/lib/vault-utils";
import { vaultRoostDir, buildSubcatsByParent } from "@/ui/lib/smart-assign/helpers";
import {
  loadAnchorNameEmbeddings,
  saveAnchorNameEmbeddings,
  lookupAnchorNameVec,
  fillMissingAnchorNames,
} from "@/lib/anchor-name-embeddings";
import {
  scoreAgainstCategories,
  generateClusterDescriptions,
  buildCategoryDefs,
} from "@/pipeline/evaluate";
import { scoreWithSubcategories } from "@/pipeline/score-with-subcategories";

import type { SmartAssignClusteringHost } from "@/ui/lib/smart-assign/clustering";
import type { ClusteringStep0Slice, ClusteringStep1Slice } from "@/ui/lib/smart-assign/clustering-context";

export async function runClusteringStep1ScoreKnown(
  host: SmartAssignClusteringHost,
  signal: StopSignal,
  ctx: Pick<ClusteringStep0Slice, "input" | "cache" | "collections" | "unsortedItemIds" | "embedder">,
): Promise<ClusteringStep1Slice | null> {
  host.setPipelineStep(1);
  host.log(`\n── Step 1: Score against known collections ──`);
  host.log(`Scoring ${ctx.unsortedItemIds.length} unsorted items against ${Object.keys(ctx.collections).length} known collections...`);
  host.setSyncProgress({ phase: "scoring", count: ctx.unsortedItemIds.length, written: 0, skipped: 0, resynced: 0 });

  const roostDir = vaultRoostDir(host.app);
  const descCachePath = roostDir + "/collection-descriptions-contrastive.json";
  const notDescCachePath = roostDir + "/collection-not-descriptions.json";
  host.refs.descCachePathRef.current = descCachePath;
  host.refs.notDescCachePathRef.current = notDescCachePath;

  let collDescs = new Map<string, string>();
  let collNotDescs = new Map<string, string>();
  try {
    const raw = require("fs").readFileSync(descCachePath, "utf8");
    for (const [k, v] of Object.entries(JSON.parse(raw))) collDescs.set(k, v as string);
  } catch { /* no cache */ }
  try {
    const raw = require("fs").readFileSync(notDescCachePath, "utf8");
    for (const [k, v] of Object.entries(JSON.parse(raw))) {
      if (typeof v === "string") collNotDescs.set(k, v);
    }
  } catch { /* no cache */ }

  if ((collDescs.size === 0 || collNotDescs.size === 0) && Object.keys(ctx.collections).length > 0) {
    host.log("Generating contrastive descriptions for collections...");
    const clusters = Object.entries(ctx.collections).map(([name, ids]) => ({ name, memberIds: ids }));
    const result = await generateClusterDescriptions({ clusters, cache: ctx.cache, onLog: host.log, stopSignal: signal });
    if (signal.stopped) { host.log("Cancelled during description generation"); host.setMode("sync"); return null; }
    collDescs = result.descriptions;
    collNotDescs = result.notDescriptions;
    try {
      const descObj: Record<string, string> = {};
      for (const [k, v] of collDescs) descObj[k] = v;
      require("fs").writeFileSync(descCachePath, JSON.stringify(descObj, null, 2));
      const notObj: Record<string, string> = {};
      for (const [k, v] of collNotDescs) notObj[k] = v;
      require("fs").writeFileSync(notDescCachePath, JSON.stringify(notObj, null, 2));
      host.log(`Cached ${collDescs.size} descriptions + ${collNotDescs.size} NOT descriptions`);
    } catch (e: unknown) {
      host.log(`[warn] Failed to cache descriptions: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const anchorCache0 = loadAnchorNameEmbeddings(host.app.vault);
  let anchorCache = anchorCache0;
  let nameEmbeddings = new Map<string, number[]>();
  try {
    anchorCache = await fillMissingAnchorNames(
      Object.keys(ctx.collections),
      anchorCache0,
      ctx.embedder.embed.bind(ctx.embedder),
    );
    if (anchorCache !== anchorCache0) {
      saveAnchorNameEmbeddings(host.app.vault, anchorCache);
    }
    for (const name of Object.keys(ctx.collections)) {
      const v = lookupAnchorNameVec(anchorCache, name);
      if (v) nameEmbeddings.set(name.toLowerCase(), v);
    }
  } catch (e: unknown) {
    host.log(`[warn] anchor-name embedding fill failed (${e instanceof Error ? e.message : String(e)}). Falling back to pure-item centroids.`);
    nameEmbeddings = new Map();
  }

  const knownCategoryDefs = buildCategoryDefs(
    ctx.collections,
    collDescs,
    ctx.cache,
    collNotDescs,
    ctx.input.itemProvenance as Map<string, AssignedBy> | undefined,
    nameEmbeddings,
  );
  host.log(`${knownCategoryDefs.length} collections with centroids`);

  const isFilterMode = ctx.input.write.into === "category";
  let phase1Assignments: Map<string, string>;
  let phase1Unmatched: string[];
  let phase1MatchDetails = new Map<string, MatchDetail>();
  let liveAssignedSubcats = new Map<string, string | null>();

  if (isFilterMode) {
    const subcatsByParent = buildSubcatsByParent(host.app, host.plugin.settings.syncFolder, ctx.cache, nameEmbeddings);
    const phase1 = await scoreWithSubcategories({
      itemIds: ctx.unsortedItemIds,
      cache: ctx.cache,
      topLevelCategories: knownCategoryDefs,
      subcatsByParent,
      vault: host.app.vault,
      onProgress: (done, total) => host.setSyncProgress({ phase: "scoring", count: total, written: done, skipped: 0, resynced: 0 }),
      onLog: host.log,
      stopSignal: signal,
      clipFusionAlpha: host.plugin.settings.clipFusionAlpha,
      embeddingOnly: host.plugin.settings.smartAssignEmbeddingOnly,
    });
    phase1Assignments = new Map();
    const newSubcats = new Map<string, string | null>();
    for (const [id, { parent, subcategory }] of phase1.assignments) {
      phase1Assignments.set(id, parent);
      newSubcats.set(id, subcategory);
    }
    liveAssignedSubcats = newSubcats;
    host.setAssignedSubcategories(prev => {
      const next = new Map(prev);
      for (const [id, sub] of newSubcats) next.set(id, sub);
      return next;
    });
    phase1Unmatched = phase1.unmatched;
    phase1MatchDetails = phase1.matchDetails;
  } else {
    const phase1 = await scoreAgainstCategories({
      itemIds: ctx.unsortedItemIds,
      cache: ctx.cache,
      categories: knownCategoryDefs,
      vault: host.app.vault,
      phaseTag: "Step 1",
      phaseDesc: `Match ${ctx.unsortedItemIds.length} unsorted items to ${Object.keys(ctx.collections).length} existing user collections`,
      onProgress: (done, total) => host.setSyncProgress({ phase: "scoring", count: total, written: done, skipped: 0, resynced: 0 }),
      onLog: host.log,
      stopSignal: signal,
      clipFusionAlpha: host.plugin.settings.clipFusionAlpha,
      embeddingOnly: host.plugin.settings.smartAssignEmbeddingOnly,
    });
    phase1Assignments = phase1.assignments;
    phase1Unmatched = phase1.unmatched;
    phase1MatchDetails = phase1.matchDetails;
  }

  if (signal.stopped) { host.log("Cancelled during scoring"); host.setMode("sync"); return null; }

  const matched: Record<string, string[]> = {};
  for (const [itemId, collName] of phase1Assignments) {
    if (!ctx.collections[collName]) ctx.collections[collName] = [];
    ctx.collections[collName].push(itemId);
    if (!matched[collName]) matched[collName] = [];
    matched[collName].push(itemId);
  }
  host.setMatchedToCollections(matched);
  host.setMatchDetailMap(phase1MatchDetails);
  host.log(`Phase 1: ${phase1Assignments.size} items matched to known collections, ${phase1Unmatched.length} unmatched`);

  host.setPipelineStep(2);

  return {
    phase1Assignments,
    phase1Unmatched,
    phase1MatchDetails,
    matched,
    liveAssignedSubcats,
    collDescs,
    collNotDescs,
    descCachePath,
    notDescCachePath,
    anchorCache,
    isFilterMode,
  };
}

