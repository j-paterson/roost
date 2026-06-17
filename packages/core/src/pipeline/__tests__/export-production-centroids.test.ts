/**
 * GUARDED EXPORTER (not a real test) — dumps the EXACT production category
 * centroids by calling the real `gatherVaultCollections` + `buildCategoryDefs`
 * over the live vault, holding out the eval fixture IDs (strict holdout, no
 * leakage). Output feeds the cost-opt eval so it measures retrieval on
 * production's actual candidate generator instead of a plain mean.
 *
 * Run explicitly:
 *   ROOST_EXPORT_CENTROIDS=1 npx vitest run \
 *     packages/core/src/pipeline/__tests__/export-production-centroids.test.ts
 *
 * Skips unless ROOST_EXPORT_CENTROIDS=1 (so the normal suite is unaffected).
 */
import { describe, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { App, TFile } from "obsidian";
import { gatherVaultCollections } from "@/lib/vault-utils";
import { buildCategoryDefs } from "@/pipeline/evaluate";

const RUN = process.env["ROOST_EXPORT_CENTROIDS"] === "1";
const VAULT = "/Users/josystem/SynologyDrive/SynologyDrive/ObsidianBookmarks";
const SYNC_FOLDER = "Bookmarks";
const ROOST = path.join(VAULT, ".roost");
const BIN = path.join(ROOST, "cache", "embedding-vectors.bin");
const META = path.join(ROOST, "cache", "embedding-meta.json");
const ANCHOR = path.join(ROOST, "cache", "anchor-name-embeddings.json");
const FIXTURE = path.join(ROOST, "build", "eval-fixture-large.json");
const OUT = path.join(ROOST, "build", process.env["ROOST_CENTROIDS_OUT"] || "production-centroids.json");

// Frontmatter fields production reads (gatherVaultCollections). Extracted by
// regex over the leading `---` block — only simple scalars, no YAML dep needed.
function readFrontmatter(file: string): Record<string, string> | null {
  const txt = fs.readFileSync(file, "utf8");
  const m = /^---\n([\s\S]*?)\n---/.exec(txt);
  if (!m) return null;
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^(roost_id|collection|roost_category|roost_assigned_by|platform):\s*(.+)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return Object.keys(fm).length ? fm : null;
}

function walkMd(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(p, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** fs-backed App shim so the REAL gatherVaultCollections runs unmodified. */
function makeApp(): App {
  const files = walkMd(path.join(VAULT, SYNC_FOLDER));
  const fmByPath = new Map<string, Record<string, string>>();
  const tfiles: TFile[] = [];
  for (const abs of files) {
    const rel = path.relative(VAULT, abs); // gatherVaultCollections checks path.startsWith(syncFolder + "/")
    const fm = readFrontmatter(abs);
    if (!fm) continue;
    fmByPath.set(rel, fm);
    tfiles.push({ path: rel } as TFile);
  }
  return {
    vault: { getMarkdownFiles: () => tfiles },
    metadataCache: { getFileCache: (f: TFile) => ({ frontmatter: fmByPath.get(f.path) }) },
  } as unknown as App;
}

function loadVectors(): Map<string, number[]> {
  const dim = JSON.parse(fs.readFileSync(META, "utf8")).dim as number;
  const raw = fs.readFileSync(BIN);
  const nl = raw.indexOf(0x0a);
  const keys: string[] = JSON.parse(raw.subarray(0, nl).toString("utf8"));
  const start = raw.byteOffset + nl + 1;
  // ArrayBuffer.slice copies into a fresh, 4-byte-aligned buffer (Float32Array
  // requires an aligned offset, which raw.byteOffset+nl+1 is not).
  const ab = raw.buffer.slice(start, start + keys.length * dim * 4);
  const floats = new Float32Array(ab);
  const map = new Map<string, number[]>();
  for (let i = 0; i < keys.length; i++) map.set(keys[i], Array.from(floats.subarray(i * dim, (i + 1) * dim)));
  return map;
}

describe("export production centroids", () => {
  it(RUN ? "dumps real buildCategoryDefs centroids (fixture held out)" : "skipped (set ROOST_EXPORT_CENTROIDS=1)", () => {
    if (!RUN) return;

    // 1. Production collections + provenance via the REAL function.
    const app = makeApp();
    const { collections, itemProvenance } = gatherVaultCollections(app, SYNC_FOLDER);

    // 2. Strict holdout: remove the fixture's items from every collection so the
    //    test items can't match themselves.
    const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    const holdout = new Set<string>(fixture.testItems.map((t: { id: string }) => t.id));
    const heldCollections: Record<string, string[]> = {};
    for (const [name, ids] of Object.entries(collections)) {
      const kept = (ids as string[]).filter((id) => !holdout.has(id));
      if (kept.length) heldCollections[name] = kept;
    }

    // 3. Cache (verified-v2 vectors) in the EmbeddingCacheEntry shape buildCategoryDefs needs.
    const vecs = loadVectors();
    const cache: Record<string, { vision: null; summary: null; category: null; vec: number[] }> = {};
    for (const [id, vec] of vecs) cache[id] = { vision: null, summary: null, category: null, vec };

    // 4. Production's exact anchor-name vectors (cached on disk; keys lowercased).
    const anchorRaw = JSON.parse(fs.readFileSync(ANCHOR, "utf8")) as Record<string, { vec: number[]; modelVersion: number }>;
    const nameEmbeddings = new Map<string, number[]>();
    for (const [k, v] of Object.entries(anchorRaw)) if (v.modelVersion === 1) nameEmbeddings.set(k, v.vec);

    // 5. Controlled variants — call the REAL buildCategoryDefs varying ONE
    //    ingredient at a time to isolate name-blend / HUMAN_WEIGHT / auto-inclusion.
    const humanOnly: Record<string, string[]> = {};
    for (const [name, ids] of Object.entries(heldCollections)) {
      const kept = ids.filter((id) => itemProvenance.get(id) === "human");
      if (kept.length) humanOnly[name] = kept;
    }
    const NONE = new Map<string, number[]>();
    const variants: Array<{ name: string; members: Record<string, string[]>; prov?: Map<string, "human" | "auto">; names: Map<string, number[]> }> = [
      { name: "prod",                 members: heldCollections, prov: itemProvenance, names: nameEmbeddings }, // production baseline
      { name: "noname",               members: heldCollections, prov: itemProvenance, names: NONE },           // isolate name-blend
      { name: "noweight",             members: heldCollections, prov: undefined,      names: nameEmbeddings }, // isolate HUMAN_WEIGHT
      { name: "noname_noweight",      members: heldCollections, prov: undefined,      names: NONE },           // pure mean, all members
      { name: "human_noname_noweight",members: humanOnly,       prov: undefined,      names: NONE },           // pure mean, human-only members
    ];

    const ROOST_BUILD = path.join(ROOST, "build");
    for (const v of variants) {
      const defs = buildCategoryDefs(
        v.members,
        new Map(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cache as any,
        undefined,
        v.prov,
        v.names,
      );
      const out: Record<string, { centroid: number[]; n: number }> = {};
      for (const d of defs) out[d.name] = { centroid: d.centroid, n: v.members[d.name]?.length ?? 0 };
      const file = v.name === "prod" ? OUT : path.join(ROOST_BUILD, `production-centroids-${v.name}.json`);
      fs.writeFileSync(file, JSON.stringify(out));
      // eslint-disable-next-line no-console
      console.log(`[export] ${v.name}: ${defs.length} centroids → ${path.basename(file)}`);
    }
  });
});
