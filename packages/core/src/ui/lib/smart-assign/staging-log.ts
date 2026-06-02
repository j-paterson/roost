/**
 * Debug log text for the Smart Assign staging tree (collection leaks + layout).
 */

export interface StagingFolderCard {
  name: string;
  count: number;
  itemIds: string[];
  pending: boolean;
}

export interface StagingLogInput {
  proposedFolders: StagingFolderCard[];
  vaultCollections: Record<string, string[]>;
  nodeCollectionMap: Map<string, string>;
  noiseFolder: { count: number } | null;
  getGroupLabel: (nodeId: string) => { name: string; itemCount: number };
}

export interface StagingLogOutput {
  leakLines: string[];
  body: string;
}

export function formatStagingTreeLog(input: StagingLogInput): StagingLogOutput {
  const allCollIds = new Set<string>();
  for (const ids of Object.values(input.vaultCollections)) {
    for (const id of ids) allCollIds.add(id);
  }

  const leakLines = input.proposedFolders
    .filter(f => f.pending)
    .map(f => {
      const leaked = f.itemIds.filter(id => allCollIds.has(id));
      return leaked.length > 0
        ? `  [LEAK] ${f.name}: ${leaked.length} collection items in discovered card`
        : null;
    })
    .filter((line): line is string => line != null);

  const collectionLines = input.proposedFolders
    .filter(f => !f.pending)
    .map(f => `  [collection] ${f.name}: ${f.count} items (${f.itemIds.length} ids)`);
  const clusterLines = input.proposedFolders
    .filter(f => f.pending)
    .map(f => `  [cluster] ${f.name}: ${f.count} items`);
  const absorbedLines = [...input.nodeCollectionMap.entries()].map(([nodeId, collName]) => {
    const { name, itemCount } = input.getGroupLabel(nodeId);
    return `  [absorbed] "${name}" (${itemCount} items) → ${collName}`;
  });
  const vaultCollLines = Object.entries(input.vaultCollections)
    .map(([name, ids]) => `  [vault] ${name}: ${ids.length} items`);
  const noiseLine = input.noiseFolder
    ? `  [noise] Uncategorized: ${input.noiseFolder.count} items`
    : "  (none)";

  const body = [
    "--- Staging tree ---",
    "Vault collections:",
    vaultCollLines.join("\n"),
    "Collection cards:",
    collectionLines.join("\n") || "  (none)",
    "Absorbed:",
    absorbedLines.join("\n") || "  (none)",
    "Discovered clusters:",
    clusterLines.join("\n") || "  (none)",
    "Noise:",
    noiseLine,
  ].join("\n");

  return { leakLines, body };
}
