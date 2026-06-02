#!/usr/bin/env node
/**
 * Filter-mode eval scenarios over top-level user categories
 * (`roost_category`). Two failure modes exercised:
 *
 *   - empty-anchor: one category is seeded with all its real items, one
 *     other category is emptied, items from the emptied category are held
 *     out. Did the system route them correctly when their target anchor
 *     had no seeded items? Pairs rotate so every eligible category gets
 *     to be both seeded and emptied across scenarios.
 *
 *   - imbalance: top two categories at ≥3:1 population ratio, both
 *     partially seeded, items held out from each. Did small-bucket-truth
 *     items leak into the big bucket?
 *
 * No sentinels: items without a roost_category are excluded from the
 * eval — they don't have ground truth at this level.
 *
 * Usage: node tests/eval/build-scenarios.mjs > tests/eval/subcat-scenarios.json
 */
import fs from "fs";
import path from "path";
import os from "os";

const VAULT = path.join(os.homedir(), "ObsidianBookmarks");
const SYNC_FOLDER = "Bookmarks";

const MIN_ITEMS_PER_CATEGORY = 30;
const MAX_EMPTY_ANCHOR_SCENARIOS = 6;
const IMBALANCE_RATIO = 3;

function readFrontmatter(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return fm;
}

function walkSync(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, ent.name);
    if (ent.isDirectory()) out.push(...walkSync(p));
    else if (ent.isFile() && p.endsWith(".md")) out.push(p);
  }
  return out;
}

function main() {
  const byCat = new Map();
  for (const file of walkSync(path.join(VAULT, SYNC_FOLDER))) {
    const fm = readFrontmatter(file);
    if (!fm?.roost_id) continue;
    const cat = fm.roost_category;
    if (!cat || cat === "undefined" || cat === "null") continue;
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(fm.roost_id);
  }

  const eligible = [...byCat.entries()]
    .filter(([, ids]) => ids.length >= MIN_ITEMS_PER_CATEGORY)
    .sort((a, b) => b[1].length - a[1].length);

  if (eligible.length < 2) {
    console.error(
      `# Only ${eligible.length} categor${eligible.length === 1 ? "y" : "ies"} ` +
      `with ≥${MIN_ITEMS_PER_CATEGORY} items found. Need ≥2 to build scenarios.`
    );
    console.log(JSON.stringify({ schemaVersion: 1, scenarios: [] }, null, 2));
    return;
  }

  const scenarios = [];

  // Empty-anchor scenarios: rotate seeded category across pairs so the
  // signal isn't dominated by one anchor. We pick pairs so that across
  // the cap, every eligible category appears at least once as the seeded
  // anchor (round-robin). Pairs are deduplicated as ordered (A→B is
  // different from B→A — the held-out items differ).
  const seenPairs = new Set();
  for (let i = 0; i < eligible.length && scenarios.length < MAX_EMPTY_ANCHOR_SCENARIOS; i++) {
    for (let j = 0; j < eligible.length && scenarios.length < MAX_EMPTY_ANCHOR_SCENARIOS; j++) {
      if (i === j) continue;
      const key = `${i}->${j}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      const [seededName, seededIds] = eligible[i];
      const [emptiedName, emptiedIds] = eligible[j];
      const heldOut = emptiedIds.slice(0, 25);
      const groundTruth = {};
      for (const id of heldOut) groundTruth[id] = emptiedName;
      scenarios.push({
        name: `empty-anchor:${seededName}-vs-${emptiedName}`,
        mode: "filter",
        anchorConfig: {
          [seededName]: seededIds,
          [emptiedName]: [],
        },
        testItems: heldOut,
        groundTruth,
      });
      // Move to the next i after one scenario at this i, to round-robin.
      break;
    }
  }

  // Imbalance scenarios: top two categories at ≥IMBALANCE_RATIO:1.
  if (eligible.length >= 2 && eligible[0][1].length >= eligible[1][1].length * IMBALANCE_RATIO) {
    const [bigName, bigIds] = eligible[0];
    const [smallName, smallIds] = eligible[1];
    const heldBig = bigIds.slice(-15);
    const heldSmall = smallIds.slice(-15);
    const seedBig = bigIds.slice(0, bigIds.length - heldBig.length);
    const seedSmall = smallIds.slice(0, smallIds.length - heldSmall.length);
    const groundTruth = {};
    for (const id of heldBig) groundTruth[id] = bigName;
    for (const id of heldSmall) groundTruth[id] = smallName;
    scenarios.push({
      name: `imbalance:${bigName}-vs-${smallName}`,
      mode: "filter",
      anchorConfig: { [bigName]: seedBig, [smallName]: seedSmall },
      testItems: [...heldBig, ...heldSmall],
      groundTruth,
    });
  }

  console.log(JSON.stringify({ schemaVersion: 1, scenarios }, null, 2));
}

main();
