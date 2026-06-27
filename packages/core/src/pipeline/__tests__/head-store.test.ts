import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileSystemAdapter } from "obsidian";
import type { Vault } from "obsidian";
import { writeStackedHeads, restorePreviousHeads } from "@/pipeline/head-store";

/**
 * Minimal vault stub whose vaultBasePath() resolves to a real temp dir.
 * vaultBasePath() (lib/vault-utils) checks `vault.adapter instanceof FileSystemAdapter`
 * then calls getBasePath(). The mock FileSystemAdapter exposes `.basePath` and
 * getBasePath() returns it — same pattern used by embedding-cache-durability.test.ts
 * and pipeline-cache.test.ts.
 */
function vaultAt(root: string): Vault {
  const adapter = new FileSystemAdapter();
  adapter.basePath = root;
  return { adapter } as unknown as Vault;
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "roost-heads-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const heads = {
  text: { classes: ["A"], W: [[1]], b: [0], dim: 1, norm: "l2" as const, trainedOn: 1, version: 1 as const },
  vision: { classes: ["A"], W: [[1]], b: [0], dim: 1, norm: "l2" as const, trainedOn: 1, version: 1 as const },
  meta: { classes: ["A"], W: [[1, 1]], b: [0], inDim: 2, norm: "none" as const, version: 1 as const },
};

describe("head-store", () => {
  it("writes the three head files", () => {
    writeStackedHeads(vaultAt(root), heads);
    for (const f of ["classifier-head-text.json", "classifier-head-vision.json", "meta-head.json"])
      expect(fs.existsSync(path.join(root, ".roost", "cache", f))).toBe(true);
  });

  it("backs up the previous head and restores it on rollback", () => {
    const v = vaultAt(root);
    writeStackedHeads(v, heads); // v1
    const v2 = { ...heads, text: { ...heads.text, W: [[2]] } };
    writeStackedHeads(v, v2);    // v2, backing up v1 → .prev
    restorePreviousHeads(v);
    const restored = JSON.parse(
      fs.readFileSync(path.join(root, ".roost", "cache", "classifier-head-text.json"), "utf8"),
    );
    expect(restored.W).toEqual([[1]]); // v1 restored
  });
});
