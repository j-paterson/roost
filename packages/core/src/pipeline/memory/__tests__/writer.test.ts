import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { __setRequestUrlImpl, __resetRequestUrlImpl } from "obsidian";
import { writeClusterToMemory, type WriterCluster } from "../writer";
import { parseConcept } from "../parser";

/**
 * Fake vault: an in-memory map of path → contents. The writer only touches
 * files under Memory/ so we expose the minimum surface it needs.
 */
function makeFakeApp() {
  const files = new Map<string, string>();
  return {
    files,
    vault: {
      adapter: {
        exists: async (path: string) => files.has(path),
        read: async (path: string) => {
          const v = files.get(path);
          if (v === undefined) throw new Error(`ENOENT: ${path}`);
          return v;
        },
        write: async (path: string, content: string) => {
          files.set(path, content);
        },
        remove: async (path: string) => { files.delete(path); },
        rename: async (from: string, to: string) => {
          const v = files.get(from);
          if (v === undefined) throw new Error(`ENOENT: ${from}`);
          files.set(to, v);
          files.delete(from);
        },
        mkdir: async (path: string) => {
          // Track directory sentinel so exists() works for parent-dir checks.
          if (!files.has(path)) files.set(path, "__dir__");
        },
        list: async (path: string) => {
          const children = [...files.keys()].filter((p) =>
            p.startsWith(path + "/") &&
            !p.slice(path.length + 1).includes("/") &&
            files.get(p) !== "__dir__",
          );
          return { files: children, folders: [] };
        },
      },
    },
  };
}


function mkCluster(overrides: Partial<WriterCluster> = {}): WriterCluster {
  return {
    bucket: "AI",
    headline: "AI Agents Move Beyond Tools",
    whyItMatters: "Agents are gaining autonomy and personalization.",
    centroid: [1, 0, 0],
    claims: [
      {
        text: "agents gain autonomy in booking and creation",
        sourceItemId: "twitter:1",
        sourcePath: "Bookmarks/X/Unknown - 1",
        embedding: [0.95, 0.05, 0],
      },
    ],
    ...overrides,
  };
}

describe("writeClusterToMemory — empty memory", () => {
  let app: ReturnType<typeof makeFakeApp>;
  beforeEach(() => { app = makeFakeApp(); });
  afterEach(() => __resetRequestUrlImpl());

  it("creates a new concept file when memory is empty", async () => {
    const result = await writeClusterToMemory(app as never, mkCluster(), "2026-05-10", () => {});
    expect(result.action).toBe("created");
    expect(app.files.has("Memory/topics/ai-agents-move-beyond-tools.md")).toBe(true);
    const parsed = parseConcept(app.files.get("Memory/topics/ai-agents-move-beyond-tools.md")!);
    expect(parsed).not.toBeNull();
    expect(parsed?.claims).toHaveLength(1);
    expect(parsed?.claims[0].text).toBe("agents gain autonomy in booking and creation");
  });

  it("populates MEMORY.md index with the new concept", async () => {
    await writeClusterToMemory(app as never, mkCluster(), "2026-05-10", () => {});
    const idx = app.files.get("Memory/MEMORY.md");
    expect(idx).toBeDefined();
    expect(idx).toContain("ai-agents-move-beyond-tools");
  });
});

describe("writeClusterToMemory — existing concept", () => {
  let app: ReturnType<typeof makeFakeApp>;
  beforeEach(() => { app = makeFakeApp(); });
  afterEach(() => __resetRequestUrlImpl());

  it("attaches to existing concept when similarity > matchThreshold", async () => {
    await writeClusterToMemory(app as never, mkCluster(), "2026-05-03", () => {});

    const second = mkCluster({
      headline: "AI Agents Continue Evolution",
      centroid: [0.99, 0.1, 0],
      claims: [
        {
          text: "agents now book travel autonomously",
          sourceItemId: "twitter:2",
          sourcePath: "Bookmarks/X/Unknown - 2",
          embedding: [0, 0, 1],
        },
      ],
    });
    const result = await writeClusterToMemory(app as never, second, "2026-05-10", () => {});
    expect(result.action).toBe("updated");
    const parsed = parseConcept(app.files.get("Memory/topics/ai-agents-move-beyond-tools.md")!);
    expect(parsed?.claims).toHaveLength(2);
  });
});

describe("writeClusterToMemory — idempotency", () => {
  let app: ReturnType<typeof makeFakeApp>;
  beforeEach(() => { app = makeFakeApp(); });

  it("is a no-op when re-run with the same cluster", async () => {
    const cluster = mkCluster();
    await writeClusterToMemory(app as never, cluster, "2026-05-10", () => {});
    const firstSnapshot = new Map(app.files);

    await writeClusterToMemory(app as never, cluster, "2026-05-10", () => {});
    // Topic file content unchanged.
    expect(app.files.get("Memory/topics/ai-agents-move-beyond-tools.md"))
      .toBe(firstSnapshot.get("Memory/topics/ai-agents-move-beyond-tools.md"));
  });
});

describe("writeClusterToMemory — multi-cluster, multi-week scenario", () => {
  let app: ReturnType<typeof makeFakeApp>;

  beforeEach(() => {
    app = makeFakeApp();
  });
  afterEach(() => __resetRequestUrlImpl());

  it("evolves memory across multiple weekly digests", async () => {
    // Week 1: bootstrap with two unrelated clusters.
    const w1ClusterA = mkCluster({
      bucket: "AI",
      headline: "AI Agents Move Beyond Tools",
      centroid: [1, 0, 0],
      claims: [
        {
          text: "agents are shifting from tools to outcomes",
          sourceItemId: "twitter:1",
          sourcePath: "Bookmarks/X/1",
          embedding: [0.99, 0.01, 0],
        },
      ],
    });
    const w1ClusterB = mkCluster({
      bucket: "Macro",
      headline: "Energy Grid Capacity Constraints",
      centroid: [0, 1, 0],
      claims: [
        {
          text: "turbine order books extend to 2030",
          sourceItemId: "twitter:2",
          sourcePath: "Bookmarks/X/2",
          embedding: [0, 0.99, 0.01],
        },
      ],
    });
    await writeClusterToMemory(app as never, w1ClusterA, "2026-04-26", () => {});
    await writeClusterToMemory(app as never, w1ClusterB, "2026-04-26", () => {});

    // Week 2: a cluster closely related to w1ClusterA — should attach.
    const w2 = mkCluster({
      bucket: "AI",
      headline: "AI Agents Continue To Evolve",
      centroid: [0.95, 0.05, 0],
      claims: [
        {
          text: "agents now handle multi-step booking flows",
          sourceItemId: "twitter:3",
          sourcePath: "Bookmarks/X/3",
          embedding: [0, 0, 1], // different content → ADD path within concept
        },
      ],
    });
    const r2 = await writeClusterToMemory(app as never, w2, "2026-05-03", () => {});
    expect(r2.action).toBe("updated");

    // Find the AI concept file (slug derived from headline of w1).
    const aiFile = Array.from(app.files.keys()).find(
      (p) => p.startsWith("Memory/topics/") && p.includes("ai-agents"),
    );
    expect(aiFile).toBeDefined();
    const ai = parseConcept(app.files.get(aiFile!)!);
    expect(ai?.claims).toHaveLength(2);
    expect(ai?.activeClaimCount).toBe(2);
    expect(ai?.sourceDigests).toContain("2026-04-26");
    expect(ai?.sourceDigests).toContain("2026-05-03");

    // Index should list both concepts.
    const idx = app.files.get("Memory/MEMORY.md")!;
    expect(idx).toContain("ai-agents");
    expect(idx).toContain("energy-grid");

    // Verify the Macro concept is untouched between weeks.
    const macroFile = Array.from(app.files.keys()).find(
      (p) => p.startsWith("Memory/topics/") && p.includes("energy-grid"),
    );
    expect(macroFile).toBeDefined();
    const macro = parseConcept(app.files.get(macroFile!)!);
    expect(macro?.claims).toHaveLength(1);
    expect(macro?.sourceDigests).toEqual(["2026-04-26"]);
  });
});
