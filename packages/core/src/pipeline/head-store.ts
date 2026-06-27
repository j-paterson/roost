/**
 * Atomic persistence and reversible swap for the three stacked-head files:
 *   classifier-head-text.json
 *   classifier-head-vision.json
 *   meta-head.json
 *
 * writeStackedHeads — atomically writes all three to <vault>/.roost/cache/,
 *   backing up each existing file to <name>.prev BEFORE overwriting so the
 *   swap is always reversible.
 *
 * restorePreviousHeads — restores the .prev backups; returns false if none
 *   exist (i.e. no prior write to roll back to).
 */

import * as fs from "fs";
import type { Vault } from "obsidian";
import { cachePath, cacheDir } from "@/lib/roost-paths";
import { vaultBasePath } from "@/lib/vault-utils";
import type { ClassifierHeadData, MetaHeadData } from "@/pipeline/classifier-head";

const FILES = [
  "classifier-head-text.json",
  "classifier-head-vision.json",
  "meta-head.json",
] as const;

/** Write data to p atomically via a .tmp sibling + rename. */
function writeAtomic(p: string, data: string): void {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, p);
}

/**
 * Atomically write the three stacked-head files to the vault cache dir.
 * Any existing file is backed up to `<file>.prev` before being overwritten,
 * making each write a reversible swap.
 *
 * Throws if vault has no filesystem base path.
 */
export function writeStackedHeads(
  vault: Vault,
  heads: { text: ClassifierHeadData; vision: ClassifierHeadData; meta: MetaHeadData },
): void {
  const root = vaultBasePath(vault);
  if (!root) throw new Error("writeStackedHeads: no vault base path — desktop only");
  fs.mkdirSync(cacheDir(root), { recursive: true });

  const payload: Record<(typeof FILES)[number], unknown> = {
    "classifier-head-text.json": heads.text,
    "classifier-head-vision.json": heads.vision,
    "meta-head.json": heads.meta,
  };

  for (const f of FILES) {
    const p = cachePath(root, f);
    // Back up current → .prev before overwriting so the swap is reversible.
    if (fs.existsSync(p)) fs.copyFileSync(p, `${p}.prev`);
    writeAtomic(p, JSON.stringify(payload[f]));
  }
}

/**
 * Restore the three stacked-head files from their `.prev` backups (i.e. undo
 * the last writeStackedHeads call).  Returns true if at least one backup was
 * restored, false if no backups exist.
 */
export function restorePreviousHeads(vault: Vault): boolean {
  const root = vaultBasePath(vault);
  if (!root) return false;
  let restored = false;
  for (const f of FILES) {
    const p = cachePath(root, f);
    const prev = `${p}.prev`;
    if (fs.existsSync(prev)) {
      fs.copyFileSync(prev, p);
      restored = true;
    }
  }
  return restored;
}
