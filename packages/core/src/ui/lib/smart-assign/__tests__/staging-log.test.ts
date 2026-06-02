import { describe, it, expect } from "vitest";
import { formatStagingTreeLog } from "@/ui/lib/smart-assign/staging-log";

describe("formatStagingTreeLog", () => {
  it("reports collection items leaking into discovered cluster cards", () => {
    const { leakLines } = formatStagingTreeLog({
      proposedFolders: [
        { name: "Recipes", count: 2, itemIds: ["a", "b"], pending: false },
        { name: "New cluster", count: 2, itemIds: ["b", "c"], pending: true },
      ],
      vaultCollections: { Recipes: ["a", "b"] },
      nodeCollectionMap: new Map(),
      noiseFolder: null,
      getGroupLabel: () => ({ name: "x", itemCount: 0 }),
    });
    expect(leakLines).toHaveLength(1);
    expect(leakLines[0]).toContain("[LEAK]");
    expect(leakLines[0]).toContain("New cluster");
  });

  it("includes vault, collection, cluster, and noise sections in body", () => {
    const { body } = formatStagingTreeLog({
      proposedFolders: [
        { name: "Recipes", count: 1, itemIds: ["a"], pending: false },
        { name: "Ideas", count: 1, itemIds: ["z"], pending: true },
      ],
      vaultCollections: { Recipes: ["a"] },
      nodeCollectionMap: new Map([["node-1", "Recipes"]]),
      noiseFolder: { count: 3 },
      getGroupLabel: (id) => ({ name: id === "node-1" ? "Leaf" : id, itemCount: 2 }),
    });
    expect(body).toContain("--- Staging tree ---");
    expect(body).toContain("[vault] Recipes");
    expect(body).toContain("[collection] Recipes");
    expect(body).toContain("[cluster] Ideas");
    expect(body).toContain("[absorbed] \"Leaf\"");
    expect(body).toContain("[noise] Uncategorized: 3");
  });
});
