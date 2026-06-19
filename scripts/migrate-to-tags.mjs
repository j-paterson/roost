// scripts/migrate-to-tags.mjs
// Bulk migration: compute multi-label category/* tags from tag-detectors.json and
// append them to each note's existing tags: array, also setting roost_category to
// the primary (highest-sigmoid) detector.
//
// Mirrors the style of scripts/recategorize-with-head.mjs:
//   - pure helper functions + import.meta.url guard
//   - DRY-RUN BY DEFAULT — pass --apply to write
//
// Forward pass (must match scripts/eval-tag-detectors.py EXACTLY):
//   x_l2norm -> z = W·x + b (per tag) -> sigmoid(z) -> fires iff sigmoid >= thresholds[t]
//   primary = argmax(sigmoid over all tags)
//
// Tag slugs are lowercased + dash-joined (valid Obsidian tags, no spaces/&).
// Nested tags use "/" separators (e.g. category/places-travel for "Places & Travel").
// APPENDS category/* tags without removing existing tags (tiktok/twitter/hashtags/collection/*).
// Does NOT duplicate tags already present in the note.
//
// DRY-RUN reports: notes touched, avg category-tags/note, category/* tag distribution.
//
// usage: node scripts/migrate-to-tags.mjs <vault-dir> [--apply]

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

// ── tag slug ──────────────────────────────────────────────────────────────────
// Obsidian tags cannot contain spaces or special chars (a space ends the tag), so
// category names must be slugified: lowercase, every run of non-alphanumerics → "-".
// "Places & Travel" → "places-travel", "Content Creation" → "content-creation".
function tagSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "untitled";
}

// Build category tag string: "category/<slug>" for a flat tag name,
// or "category/<parentSlug>/<childSlug>" for a "Parent/Child" tag name.
function tagToObsidianTag(tagName) {
  // Support nested: "Parent/Child" → category/parent-slug/child-slug
  const parts = tagName.split("/").map((p) => tagSlug(p.trim()));
  return "category/" + parts.join("/");
}

// ── Frontmatter helpers (line-oriented, same pattern as recategorize-with-head.mjs) ─

function splitFm(content) {
  if (!/^---\r?\n/.test(content)) return null;
  const end = content.indexOf("\n---", 4);
  return end === -1 ? null : { head: content.slice(0, end), rest: content.slice(end) };
}

function readKey(lines, key) {
  const l = lines.find((x) => new RegExp(`^${key}\\s*:`).test(x));
  if (!l) return null;
  const v = l.replace(new RegExp(`^${key}\\s*:\\s*`), "").trim().replace(/^["']|["']$/g, "");
  return v.length ? v : null;
}

function needsQuote(v) {
  return /[:#&!|>%@*`{}\[\],"']/.test(v) || /^[\s>?-]/.test(v);
}

function setKey(lines, key, value) {
  const i = lines.findIndex((x) => new RegExp(`^${key}\\s*:`).test(x));
  const line = `${key}: ${needsQuote(value) ? JSON.stringify(value) : value}`;
  if (i >= 0) lines[i] = line;
  else lines.push(line);
}

// Read the YAML block-list tags array from frontmatter lines.
// Handles both block-list (  - tag) and inline ([tag1, tag2]) forms.
// Returns an array of tag strings.
function readTags(lines) {
  const i = lines.findIndex((l) => /^tags\s*:/.test(l));
  if (i === -1) return [];

  const headerLine = lines[i];
  // Inline form: tags: [a, b, c]
  const inlineMatch = headerLine.match(/^tags\s*:\s*\[(.+)\]/);
  if (inlineMatch) {
    return inlineMatch[1]
      .split(",")
      .map((t) => t.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }

  // Block-list form: tags:\n  - a\n  - b
  const tags = [];
  let j = i + 1;
  while (j < lines.length && /^\s+-\s*/.test(lines[j])) {
    const raw = lines[j].replace(/^\s+-\s*/, "").trim().replace(/^["']|["']$/g, "");
    if (raw) tags.push(raw);
    j++;
  }
  return tags;
}

// Rewrite the tags: block in frontmatter lines, preserving all existing tags and
// appending any new ones. Returns a new lines array.
function appendTags(lines, newTags) {
  if (newTags.length === 0) return lines;

  const i = lines.findIndex((l) => /^tags\s*:/.test(l));

  if (i === -1) {
    // No tags key at all — add a new block-list after the last line
    const out = [...lines];
    out.push("tags:");
    for (const t of newTags) out.push(`  - ${t}`);
    return out;
  }

  const headerLine = lines[i];
  const inlineMatch = headerLine.match(/^tags\s*:\s*\[(.+)\]/);

  if (inlineMatch) {
    // Inline form — expand to block-list and append
    const existing = inlineMatch[1]
      .split(",")
      .map((t) => t.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    const out = [...lines];
    const block = ["tags:", ...existing.map((t) => `  - ${t}`), ...newTags.map((t) => `  - ${t}`)];
    out.splice(i, 1, ...block);
    return out;
  }

  // Block-list form: find the extent of existing items
  let j = i + 1;
  while (j < lines.length && /^\s+-\s*/.test(lines[j])) j++;
  // j is now the line AFTER the last - item; insert new items before j
  const out = [...lines];
  const newLines = newTags.map((t) => `  - ${t}`);
  out.splice(j, 0, ...newLines);
  return out;
}

// ── Embedding cache loader (mirrors recategorize-with-head.mjs) ────────────────

function loadEmbeddingCache(cacheDir) {
  const binPath = join(cacheDir, "embedding-vectors.bin");
  const metaPath = join(cacheDir, "embedding-meta.json");
  const jsonPath = join(cacheDir, "embedding-cache.json");

  const cache = new Map(); // id (string) → Float32Array(dim)

  if (existsSync(binPath)) {
    if (!existsSync(metaPath)) {
      throw new Error(`embedding-meta.json not found alongside ${binPath}`);
    }
    const dim = JSON.parse(readFileSync(metaPath, "utf8")).dim;
    const raw = readFileSync(binPath);
    const nl = raw.indexOf(0x0a);
    const keys = JSON.parse(raw.slice(0, nl).toString("utf8"));
    const start = nl + 1;
    const bytesPerVec = dim * 4;
    for (let i = 0; i < keys.length; i++) {
      const offset = start + i * bytesPerVec;
      const ab = raw.buffer.slice(raw.byteOffset + offset, raw.byteOffset + offset + bytesPerVec);
      cache.set(keys[i], new Float32Array(ab));
    }
  }

  if (existsSync(jsonPath)) {
    const entries = JSON.parse(readFileSync(jsonPath, "utf8"));
    for (const [k, v] of Object.entries(entries)) {
      if (typeof v === "object" && v !== null && Array.isArray(v.vec) && !cache.has(k)) {
        cache.set(k, new Float32Array(v.vec));
      }
    }
  }

  return cache;
}

// ── Tag-detector forward pass (mirrors eval-tag-detectors.py EXACTLY) ─────────
// x_l2norm -> z = W·x + b (per tag) -> sigmoid(z) -> fires iff sigmoid >= thresholds[t]
// primary = argmax(sigmoid over all tags)

function l2Normalize(vec) {
  let norm = 0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return new Float32Array(vec);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

function sigmoid(z) {
  return 1.0 / (1.0 + Math.exp(-z));
}

/**
 * Run the tag-detector forward pass for one embedding vector.
 * Returns { firingTags: string[], primary: string, sigmoids: Float32Array }.
 * firingTags = all tags whose sigmoid >= threshold (ordered by sigmoid desc).
 * primary = the tag with the highest sigmoid (argmax, not just those that fire).
 */
export function classifyWithDetectors(vec, detectors) {
  const { tags, W, b, thresholds } = detectors;
  const T = tags.length;
  const xNorm = l2Normalize(vec);

  const sigs = new Float32Array(T);
  for (let t = 0; t < T; t++) {
    const row = W[t];
    let dot = 0;
    for (let d = 0; d < row.length; d++) dot += row[d] * xNorm[d];
    sigs[t] = sigmoid(dot + b[t]);
  }

  // Primary = argmax sigmoid (regardless of threshold)
  let primaryIdx = 0;
  let maxSig = sigs[0];
  for (let t = 1; t < T; t++) {
    if (sigs[t] > maxSig) { maxSig = sigs[t]; primaryIdx = t; }
  }

  // Firing = all tags where sigmoid >= threshold
  const firing = [];
  for (let t = 0; t < T; t++) {
    if (sigs[t] >= thresholds[t]) firing.push(tags[t]);
  }
  // Sort firing tags by sigmoid descending for deterministic order
  firing.sort((a, b) => sigs[tags.indexOf(b)] - sigs[tags.indexOf(a)]);

  return { firingTags: firing, primary: tags[primaryIdx], sigmoids: sigs };
}

// ── Pure per-note transform ────────────────────────────────────────────────────

/**
 * Pure: apply tag detectors to one note's content.
 * Returns { content, changed, addedTags, newPrimary, oldPrimary }.
 *
 * Rules:
 *  - Needs a cached embedding vec to operate; skips without one.
 *  - APPENDS category/<slug> tags for every firing tag not already in tags:.
 *  - Sets roost_category to the primary (highest-sigmoid) tag.
 *  - Does NOT remove any existing tags (tiktok/twitter/hashtags/collection/*).
 *  - Does NOT duplicate tags already present.
 */
export function migrateNote(content, roostId, detectors, embCache) {
  const fm = splitFm(content);
  if (!fm) return { content, changed: false, addedTags: [], newPrimary: null, oldPrimary: null };

  const lines = fm.head.split("\n");

  const vec = embCache.get(roostId);
  if (!vec) return { content, changed: false, addedTags: [], newPrimary: null, oldPrimary: null };

  const { firingTags, primary } = classifyWithDetectors(vec, detectors);

  const oldPrimary = readKey(lines, "roost_category");

  // PRESERVE an existing valid primary (human-assigned, or the already-validated balanced-head
  // category). Only (re)assign roost_category when it is ABSENT or a DROPPED tag (e.g. Content
  // Creation, no longer in the canon). This never clobbers a human category or re-churns the
  // validated primaries — the migration is otherwise ADD-ONLY (it appends category/* tags).
  const canon = new Set(detectors.tags);
  const keepPrimary = !!(oldPrimary && canon.has(oldPrimary));
  const effectivePrimary = keepPrimary ? oldPrimary : primary;

  // Map firing tags + the effective primary to Obsidian category/ tag strings
  const obsidianCatTags = firingTags.map(tagToObsidianTag);
  const primaryObsTag = tagToObsidianTag(effectivePrimary);

  const existingTags = new Set(readTags(lines));
  const toAdd = obsidianCatTags.filter((t) => !existingTags.has(t));
  // Ensure the effective primary tag is present even if its detector didn't fire
  if (!existingTags.has(primaryObsTag) && !toAdd.includes(primaryObsTag)) {
    toAdd.push(primaryObsTag);
  }

  const setPrimary = !keepPrimary && primary !== oldPrimary;

  if (toAdd.length === 0 && !setPrimary) {
    return { content, changed: false, addedTags: [], newPrimary: effectivePrimary, oldPrimary };
  }

  let newLines = appendTags(lines, toAdd);
  if (setPrimary) {
    setKey(newLines, "roost_category", primary);
  }

  return {
    content: newLines.join("\n") + fm.rest,
    changed: true,
    addedTags: toAdd,
    newPrimary: effectivePrimary,
    oldPrimary: oldPrimary ?? "(none)",
  };
}

// ── Vault walker ───────────────────────────────────────────────────────────────

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

// ── roost_id extractor ─────────────────────────────────────────────────────────

function readRoostId(content) {
  const fm = splitFm(content);
  if (!fm) return null;
  return readKey(fm.head.split("\n"), "roost_id");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const apply = process.argv.includes("--apply");
  const vault = process.argv.find(
    (a) => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1]
  );
  if (!vault) {
    console.error("usage: node scripts/migrate-to-tags.mjs <vault-dir> [--apply]");
    process.exit(1);
  }

  const cacheDir = join(vault, ".roost", "cache");
  const detectorsPath = join(cacheDir, "tag-detectors.json");

  if (!existsSync(detectorsPath)) {
    console.error(`tag-detectors.json not found at ${detectorsPath}`);
    process.exit(1);
  }

  console.log("Loading tag detectors…");
  const detectors = JSON.parse(readFileSync(detectorsPath, "utf8"));
  const { tags, W, b, thresholds, norm } = detectors;
  if (
    !Array.isArray(tags) ||
    !Array.isArray(W) ||
    !Array.isArray(b) ||
    !Array.isArray(thresholds) ||
    norm !== "l2" ||
    W.length !== tags.length ||
    b.length !== tags.length ||
    thresholds.length !== tags.length
  ) {
    console.error("tag-detectors.json failed structural validation");
    process.exit(1);
  }
  console.log(`  ${tags.length} tags, norm=${norm}`);
  console.log(`  tags: ${tags.join(", ")}`);

  console.log("Loading embedding cache…");
  const embCache = loadEmbeddingCache(cacheDir);
  console.log(`  ${embCache.size} cached vectors`);

  console.log("Walking vault…");
  const files = await walk(vault);
  console.log(`  ${files.length} .md files`);

  // Counters
  let notesWithId = 0;
  let notesWithVec = 0;
  let notesTouched = 0;
  let totalCatTagsAdded = 0;

  // Distribution: category tag slug → note count (notes where that tag was added)
  const catTagDist = {};
  // Primary distribution: new primary → count
  const primaryDist = {};

  for (const f of files) {
    const before = readFileSync(f, "utf8");
    const roostId = readRoostId(before);
    if (!roostId) continue;
    notesWithId++;

    const vec = embCache.get(roostId);
    if (!vec) continue;
    notesWithVec++;

    const { content, changed, addedTags, newPrimary } = migrateNote(before, roostId, detectors, embCache);

    if (newPrimary) {
      primaryDist[newPrimary] = (primaryDist[newPrimary] ?? 0) + 1;
    }

    if (changed) {
      notesTouched++;
      totalCatTagsAdded += addedTags.length;
      for (const t of addedTags) {
        catTagDist[t] = (catTagDist[t] ?? 0) + 1;
      }
      if (apply) writeFileSync(f, content);
    }
  }

  // ── Report ─────────────────────────────────────────────────────────────────

  const verb = apply ? "APPLIED" : "DRY-RUN";
  console.log("");
  console.log(`── ${verb} ─────────────────────────────────────────────`);
  console.log(`Notes with roost_id:        ${notesWithId}`);
  console.log(`  with cached embedding:    ${notesWithVec}`);
  console.log(`  touched (changes made):   ${notesTouched}`);
  if (notesTouched > 0) {
    const avg = (totalCatTagsAdded / notesTouched).toFixed(2);
    console.log(`  avg category tags added:  ${avg}`);
  }
  console.log("");

  // category/* tag distribution (sorted by count desc)
  console.log("category/* tag distribution (tags added, sorted by count):");
  const sortedCatTags = Object.entries(catTagDist).sort((a, b) => b[1] - a[1]);
  if (sortedCatTags.length === 0) {
    console.log("  (none — all category tags already present)");
  } else {
    for (const [tag, count] of sortedCatTags) {
      console.log(`  ${tag.padEnd(30)} ${String(count).padStart(6)} notes`);
    }
  }

  console.log("");
  console.log("Primary (roost_category) distribution after migration:");
  const sortedPrimary = Object.entries(primaryDist).sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of sortedPrimary) {
    console.log(`  ${cat.padEnd(25)} ${String(count).padStart(6)} notes`);
  }

  if (!apply) {
    console.log("");
    console.log("(dry-run — no files written; pass --apply to write)");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
