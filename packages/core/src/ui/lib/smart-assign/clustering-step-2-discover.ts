import { TAXONOMY_EPSILON_DEFAULT } from "@/config";
import type { ClassifyProposalData } from "@/types/roost";
import type { StopSignal } from "@/types/sync";
import {
  saveAnchorNameEmbeddings,
  lookupAnchorNameVec,
  fillMissingAnchorNames,
} from "@/lib/anchor-name-embeddings";
import { computeCentroid, computeCohesion } from "@/pipeline/shared";
import { dedupDiscoveredByCentroid, CENTROID_DEDUP_THRESHOLD } from "@/ui/lib/smart-assign/dedup-discovered";
import { embedCategories, clusterCategories } from "@/pipeline/taxonomy";
import {
  discoverCategories,
  generateClusterDescriptions,
  buildCategoryDefs,
  scoreAgainstCategories,
} from "@/pipeline/evaluate";
import { scoreWithSubcategories } from "@/pipeline/score-with-subcategories";

import type { SmartAssignClusteringHost } from "@/ui/lib/smart-assign/clustering";
import { PIPELINE_STEP } from "@/ui/lib/smart-assign/pipeline-steps";
import type { ClusteringStep0Slice, ClusteringStep1Slice, ClusteringStep2Slice } from "@/ui/lib/smart-assign/clustering-context";

export async function runClusteringStep2DiscoverAndScore(
  host: SmartAssignClusteringHost,
  signal: StopSignal,
  ctx: Pick<
    ClusteringStep0Slice & ClusteringStep1Slice,
    | "input"
    | "cache"
    | "embedder"
    | "platform"
    | "collections"
    | "phase1Unmatched"
    | "isFilterMode"
    | "collDescs"
    | "collNotDescs"
    | "descCachePath"
    | "notDescCachePath"
    | "anchorCache"
  >,
): Promise<ClusteringStep2Slice | null> {
  let miscIds: string[] = [];
  let result: ClassifyProposalData | null = null;

  // Subcategorize scope constrains destinations to the parent's existing
  // subcategories — no new-subcategory discovery. Unmatched items fall
  // through as Misc and land in the parent category without a subcat.
  if (ctx.phase1Unmatched.length > 0 && ctx.input.allowDiscovery) {
    host.log(`\n── Step 2: Discovering categories from ${ctx.phase1Unmatched.length} unmatched items ──`);
    host.log("Building category taxonomy for synonym merging...");

    const catEmbeddings = await embedCategories(ctx.cache, host.app.vault, host.log, ctx.embedder);
    if (signal.stopped) { host.log("Cancelled during taxonomy build"); host.setMode("sync"); return null; }
    host.refs.catEmbeddingsRef.current = catEmbeddings;
    const taxonomy = clusterCategories(catEmbeddings, TAXONOMY_EPSILON_DEFAULT, host.log);
    host.refs.taxonomyRef.current = taxonomy;

    const existingNames = new Set(Object.keys(ctx.collections));
    let discovered = discoverCategories(ctx.phase1Unmatched, ctx.cache, existingNames, host.log, taxonomy);

    const dedup = dedupDiscoveredByCentroid(discovered, ctx.cache);
    if (dedup.mergedCount > 0) {
      host.log(`\nCentroid dedup: merged ${dedup.mergedCount} proposal(s) at cosine ≥${CENTROID_DEDUP_THRESHOLD}`);
      for (const line of dedup.mergeLog) host.log(line);
    }
    discovered = dedup.discovered;

    if (discovered.length > 0) {
      host.setPipelineStep(PIPELINE_STEP.DESCRIBE);
      host.log(`\n── Step 3: Generating contrastive descriptions for ${discovered.length} new categories ──`);
      const clusterDefs = discovered.map(d => ({ name: d.name, memberIds: d.itemIds }));
      const newDescResult = await generateClusterDescriptions({
        clusters: clusterDefs,
        cache: ctx.cache,
        onLog: host.log,
        stopSignal: signal,
      });
      if (signal.stopped) { host.log("Cancelled during description"); host.setMode("sync"); return null; }

      for (const [k, v] of newDescResult.descriptions) ctx.collDescs.set(k, v);
      for (const [k, v] of newDescResult.notDescriptions) ctx.collNotDescs.set(k, v);
      try {
        const descObj: Record<string, string> = {};
        for (const [k, v] of ctx.collDescs) descObj[k] = v;
        const notObj: Record<string, string> = {};
        for (const [k, v] of ctx.collNotDescs) notObj[k] = v;
        require("fs").writeFileSync(ctx.descCachePath, JSON.stringify(descObj, null, 2));
        require("fs").writeFileSync(ctx.notDescCachePath, JSON.stringify(notObj, null, 2));
        host.log(`Persisted ${newDescResult.descriptions.size} new descriptions to disk`);
      } catch (e: unknown) {
        host.log(`[warn] Failed to persist new descriptions: ${e instanceof Error ? e.message : String(e)}`);
      }

      host.setNewClusterDescriptions(new Map(newDescResult.descriptions));
      host.setNewClusterNotDescriptions(new Map(newDescResult.notDescriptions));

      host.setPipelineStep(PIPELINE_STEP.SCORE_NEW);
      host.setSyncProgress({ phase: "scoring", count: 0, written: 0, skipped: 0, resynced: 0 });
      const newCollections: Record<string, string[]> = {};
      for (const d of discovered) newCollections[d.name] = d.itemIds;

      // Phase 4: score remaining items against discovered categories
      let anchorCache = ctx.anchorCache;
      let newNameEmbeddings = new Map<string, number[]>();
      try {
        const newCacheUpdated = await fillMissingAnchorNames(
          Object.keys(newCollections),
          anchorCache,
          ctx.embedder.embed.bind(ctx.embedder),
        );
        if (newCacheUpdated !== anchorCache) {
          saveAnchorNameEmbeddings(host.app.vault, newCacheUpdated);
          anchorCache = newCacheUpdated;
        }
        for (const name of Object.keys(newCollections)) {
          const v = lookupAnchorNameVec(anchorCache, name);
          if (v) newNameEmbeddings.set(name.toLowerCase(), v);
        }
      } catch (e: unknown) {
        host.log(`[warn] anchor-name embedding fill (Phase 5) failed (${e instanceof Error ? e.message : String(e)}). Falling back to pure-item centroids.`);
        newNameEmbeddings = new Map();
      }

      const newCategoryDefs = buildCategoryDefs(
        newCollections,
        newDescResult.descriptions,
        ctx.cache,
        newDescResult.notDescriptions,
        undefined,
        newNameEmbeddings,
      );

      const seededIds = new Set(discovered.flatMap(d => d.itemIds));
      const toScore = ctx.phase1Unmatched.filter(id => !seededIds.has(id));
      host.log(`\n── Step 4: Scoring ${toScore.length} remaining items against ${discovered.length} new categories ──`);
      host.log(`(${seededIds.size} items already seeded in discovered categories)`);

      if (toScore.length > 0) {
        let phase2Assignments: Map<string, string>;
        let phase2Unmatched: string[];
        if (ctx.isFilterMode) {
          const phase2 = await scoreWithSubcategories({
            itemIds: toScore,
            cache: ctx.cache,
            topLevelCategories: newCategoryDefs,
            subcatsByParent: new Map(),
            vault: host.app.vault,
            onProgress: (done, total) => host.setSyncProgress({ phase: "scoring", count: total, written: done, skipped: 0, resynced: 0 }),
            onLog: host.log,
            stopSignal: signal,
            clipFusionAlpha: host.plugin.settings.clipFusionAlpha,
          });
          phase2Assignments = new Map();
          for (const [id, { parent }] of phase2.assignments) phase2Assignments.set(id, parent);
          phase2Unmatched = phase2.unmatched;
        } else {
          const phase2 = await scoreAgainstCategories({
            itemIds: toScore,
            cache: ctx.cache,
            categories: newCategoryDefs,
            vault: host.app.vault,
            phaseTag: "Step 5",
            phaseDesc: `Match ${toScore.length} remaining items to ${discovered.length} discovered categories`,
            onProgress: (done, total) => host.setSyncProgress({ phase: "scoring", count: total, written: done, skipped: 0, resynced: 0 }),
            onLog: host.log,
            stopSignal: signal,
            clipFusionAlpha: host.plugin.settings.clipFusionAlpha,
            embeddingOnly: host.plugin.settings.smartAssignEmbeddingOnly,
          });
          phase2Assignments = phase2.assignments;
          phase2Unmatched = phase2.unmatched;
        }
        if (signal.stopped) { host.log("Cancelled during scoring"); host.setMode("sync"); return null; }

        for (const [itemId, catName] of phase2Assignments) {
          const cat = discovered.find(d => d.name === catName);
          if (cat) cat.itemIds.push(itemId);
        }
        miscIds = phase2Unmatched;
        host.log(`\nPhase 2: ${phase2Assignments.size} assigned to new categories, ${miscIds.length} → Misc`);
      }

      const proposals = discovered
        .filter(d => d.itemIds.length > 0)
        .map(d => ({
          suggestedName: d.name,
          altNames: [d.name],
          count: d.itemIds.length,
          itemIds: d.itemIds,
          samples: d.itemIds.slice(0, 6).map(id => ({ id, name: ctx.cache[id]?.summary || id, summary: ctx.cache[id]?.summary || undefined })),
          confidence: 0,
          source: "cluster" as const,
          fromCollection: false,
        }))
        .sort((a, b) => b.count - a.count);

      host.log(`\n── Final categories ──`);
      for (const p of proposals) {
        const vecs = p.itemIds.filter((id: string) => ctx.cache[id]?.vec).map((id: string) => ctx.cache[id].vec!);
        const cohesion = vecs.length > 1 ? computeCohesion(vecs, computeCentroid(vecs)).toFixed(4) : "n/a";
        host.log(`  ${String(p.count).padStart(5)}  ${p.suggestedName} (cohesion ${cohesion})`);
      }

      result = {
        proposals,
        platform: ctx.platform || "",
        noiseItemIds: miscIds,
        collections: ctx.collections,
      };
    } else {
      host.log("No categories discovered with enough items — all unmatched → Misc");
      miscIds = ctx.phase1Unmatched;
      result = {
        proposals: [],
        platform: ctx.platform || "",
        noiseItemIds: miscIds,
        collections: ctx.collections,
      };
    }
  } else if (!ctx.input.allowDiscovery) {
    const parentLabel = ctx.input.write.into === "subcategoryOf" ? ` in \"${ctx.input.write.parent}\"` : "";
    host.log(`Discovery disabled: ${ctx.phase1Unmatched.length} unmatched items will go to Misc${parentLabel}`);
    miscIds = ctx.phase1Unmatched;
    result = {
      proposals: [],
      platform: ctx.platform || "",
      noiseItemIds: miscIds,
      collections: ctx.collections,
    };
  } else {
    host.log("All items matched known collections — no new categories needed");
    result = {
      proposals: [],
      platform: ctx.platform || "",
      noiseItemIds: [],
      collections: ctx.collections,
    };
  }

  host.setVaultCollections(ctx.collections);
  host.setProposal(result);
  host.loadFromClusterOutput(result);

  return { result, miscIds };
}

