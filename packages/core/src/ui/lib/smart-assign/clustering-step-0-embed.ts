import { EMBED_URL } from "@/config";
import type { EmbeddingCacheEntry, SmartAssignInput } from "@/types/roost";
import type { StopSignal } from "@/types/sync";
import { describeItems, resolveFfmpeg } from "@/pipeline/describe-items";
import { findBinary } from "@/integrations/detect";
import { loadEmbeddingCache, stripPreamble } from "@/pipeline/shared";
import { requestUrl } from "obsidian";

import type { SmartAssignClusteringHost } from "@/ui/lib/smart-assign/clustering";
import type { ClusteringStep0Slice } from "@/ui/lib/smart-assign/clustering-context";

export async function runClusteringStep0Embed(
  host: SmartAssignClusteringHost,
  signal: StopSignal,
): Promise<ClusteringStep0Slice | null> {
  host.log(`\n── Step 0: Embed ──`);
  const input = host.getInput();
  if (!input) {
    host.log("[runClustering] no input stashed — aborting");
    host.setMode("sync");
    return null;
  }

  const embedder = await host.plugin.createEmbedder({
    probeSidecar: async () => {
      try {
        const res = await requestUrl({ url: `${EMBED_URL}/api/tags`, method: "GET" });
        return res.status >= 200 && res.status < 300;
      } catch { return false; }
    },
    settings: { embeddingBackend: host.plugin.settings.embeddingBackend ?? "auto" },
  });
  // Dispose any previously active embedder and stash the new one so the
  // plugin can dispose it on unload (or the next Smart Assign run).
  host.plugin.activeEmbedder?.dispose();
  host.plugin.activeEmbedder = embedder;
  host.log(`Embedding backend: ${embedder.name}`);

  host.log(`Checking for ${input.itemIds.length} items that need embedding...`);
  host.setSyncProgress({ phase: "scanning", count: 0, written: 0, skipped: 0, resynced: 0 });
  const embedResult = await describeItems({
    vault: host.app.vault,
    app: host.app,
    syncFolder: host.plugin.settings.syncFolder,
    topics: host.getUserTopics().length > 0 ? host.getUserTopics() : undefined,
    itemIds: input.itemIds,
    embedder,
    onProgress: (processed, total) =>
      host.setSyncProgress({ phase: "embedding", count: total, written: processed, skipped: 0, resynced: 0 }),
    onLog: host.log,
    stopSignal: signal,
    ffmpeg: resolveFfmpeg(host.plugin.settings.integrations.ffmpeg, findBinary),
  });
  if (signal.stopped) { host.log("Smart Assign cancelled during embedding"); host.setMode("sync"); return null; }
  if (embedResult.processed > 0) host.log(`Embedded ${embedResult.processed} items (${embedResult.errors} errors)`);

  const cache = loadEmbeddingCache(host.app.vault);
  const platform = host.refs.platformRef.current;

  const anchorItemIds = new Set<string>();
  const itemCollectionsAll = new Map<string, string>();
  for (const [name, ids] of Object.entries(input.collections)) {
    for (const id of ids) {
      itemCollectionsAll.set(id, name);
      anchorItemIds.add(id);
    }
  }

  const allItemIdsSet = new Set<string>([...input.itemIds, ...anchorItemIds]);
  const items = [...allItemIdsSet]
    .filter(id => cache[id]?.vec)
    .map(id => ({ id }));

  host.log(
    `Using ${input.itemIds.length} target items + ${anchorItemIds.size} anchor items (${items.length} have vecs), ${itemCollectionsAll.size} labeled`,
  );

  const unsortedIdSet = new Set<string>();
  const targetPlatformIds = new Set<string>();
  for (const id of input.itemIds) {
    if (!cache[id]?.vec) continue;
    unsortedIdSet.add(id);
    targetPlatformIds.add(id);
  }
  host.log(`  target itemsWithVec=${targetPlatformIds.size} of ${input.itemIds.length}`);
  host.setUnsortedIds(unsortedIdSet);

  const itemCollections = new Map<string, string>();
  const vecIdSet = new Set(items.map(i => i.id));
  for (const [id, name] of itemCollectionsAll) {
    if (!vecIdSet.has(id)) continue;
    if (host.getUserTopics().length > 0 && !host.getUserTopics().some(t => t.toLowerCase() === name.toLowerCase())) continue;
    itemCollections.set(id, name);
  }

  const collCounts = new Map<string, number>();
  const collItems = new Map<string, string[]>();
  for (const [itemId, name] of itemCollections) {
    collCounts.set(name, (collCounts.get(name) || 0) + 1);
    if (!collItems.has(name)) collItems.set(name, []);
    collItems.get(name)!.push(itemId);
  }
  for (const topic of host.getUserTopics()) {
    if (!collCounts.has(topic) && ![...collCounts.keys()].some(k => k.toLowerCase() === topic.toLowerCase())) {
      collCounts.set(topic, 0);
    }
  }

  host.log(`${collCounts.size} topic anchors (${itemCollections.size} labeled items):`);
  for (const [name, count] of [...collCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const ids = collItems.get(name) || [];
    const catCounts = new Map<string, number>();
    const topicSamples: string[] = [];
    for (const id of ids) {
      const entry = cache[id];
      if (entry?.category) catCounts.set(entry.category, (catCounts.get(entry.category) || 0) + 1);
      if (entry?.summary && topicSamples.length < 3) topicSamples.push(stripPreamble(entry.summary).slice(0, 80));
    }
    const topCats = [...catCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([c, n]) => `${c}(${n})`)
      .join(", ");
    host.log(`  ${String(count).padStart(5)}  ${name}${count === 0 ? " (name-only)" : ""}`);
    if (topCats) host.log(`         categories: ${topCats}`);
    if (topicSamples.length > 0) host.log(`         samples: ${topicSamples.join(" | ")}`);
  }

  const globalCatCounts = new Map<string, number>();
  for (const item of items) {
    const cat = cache[item.id]?.category;
    if (cat) globalCatCounts.set(cat, (globalCatCounts.get(cat) || 0) + 1);
  }
  const catDistLines = [...globalCatCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([cat, n]) => `  ${String(n).padStart(5)}  ${cat}`);
  host.log(`Category distribution (top 30 of ${globalCatCounts.size} unique, ${items.length} items):\n${catDistLines.join("\n")}`);

  const collections: Record<string, string[]> = {};
  for (const [itemId, collName] of itemCollections) {
    if (!collections[collName]) collections[collName] = [];
    collections[collName].push(itemId);
  }
  for (const topic of host.getUserTopics()) {
    if (!collections[topic] && ![...Object.keys(collections)].some(k => k.toLowerCase() === topic.toLowerCase())) {
      collections[topic] = [];
    }
  }

  const collectionIdSet = new Set(itemCollections.keys());

  const unsortedItemIds = items
    .filter(i => !collectionIdSet.has(i.id) && targetPlatformIds.has(i.id))
    .map(i => i.id);

  return {
    input,
    platform,
    cache,
    embedder,
    items,
    collections,
    unsortedIdSet,
    targetPlatformIds,
    collectionIdSet,
    unsortedItemIds,
  };
}

