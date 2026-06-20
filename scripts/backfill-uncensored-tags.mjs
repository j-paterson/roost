// scripts/backfill-uncensored-tags.mjs
// One-time backfill: for each note whose roost_category OR any collection/* tag is in
// --categories (the uncensored category names, e.g. "Spicy"), resolve its cover/keyframe/video
// paths, POST them to the sidecar /classify-uncensored endpoint, and — if the max score
// >= 0.5 — APPEND the corresponding category/<slug> tag if it isn't already present.
//
// Mirrors the style of scripts/migrate-to-tags.mjs:
//   - pure helper functions + import.meta.url guard
//   - DRY-RUN BY DEFAULT — pass --apply to write
//
// The migration was text-only; this script adds the image signal to EXISTING items.
// The local classifier is used because cloud LLMs refuse explicit/uncensored content.
//
// DRY-RUN reports: items checked, images found, how many would gain category/<slug>.
//
// usage:
//   node scripts/backfill-uncensored-tags.mjs <vault-dir> [--categories "Spicy"] [--apply]
//
// Example dry-run (default categories = "Spicy"):
//   node scripts/backfill-uncensored-tags.mjs /path/to/vault
//
// Example apply:
//   node scripts/backfill-uncensored-tags.mjs /path/to/vault --categories "Spicy" --apply

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";

const SIDECAR_URL = "http://127.0.0.1:11435/classify-uncensored";
const UNCENSORED_THRESHOLD = 0.5;

// ── Tag slug (mirrors migrate-to-tags.mjs exactly) ────────────────────────────
function tagSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "untitled";
}

function categoryTag(categoryName) {
  // "Spicy" → "category/spicy", "My Category" → "category/my-category"
  const parts = categoryName.split("/").map((p) => tagSlug(p.trim()));
  return "category/" + parts.join("/");
}

// ── Frontmatter helpers (mirrors migrate-to-tags.mjs) ─────────────────────────

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

function readTags(lines) {
  const i = lines.findIndex((l) => /^tags\s*:/.test(l));
  if (i === -1) return [];

  const headerLine = lines[i];
  const inlineMatch = headerLine.match(/^tags\s*:\s*\[(.+)\]/);
  if (inlineMatch) {
    return inlineMatch[1]
      .split(",")
      .map((t) => t.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }

  const tags = [];
  let j = i + 1;
  while (j < lines.length && /^\s+-\s*/.test(lines[j])) {
    const raw = lines[j].replace(/^\s+-\s*/, "").trim().replace(/^["']|["']$/g, "");
    if (raw) tags.push(raw);
    j++;
  }
  return tags;
}

function appendTags(lines, newTags) {
  if (newTags.length === 0) return lines;

  const i = lines.findIndex((l) => /^tags\s*:/.test(l));

  if (i === -1) {
    const out = [...lines];
    out.push("tags:");
    for (const t of newTags) out.push(`  - ${t}`);
    return out;
  }

  const headerLine = lines[i];
  const inlineMatch = headerLine.match(/^tags\s*:\s*\[(.+)\]/);

  if (inlineMatch) {
    const existing = inlineMatch[1]
      .split(",")
      .map((t) => t.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    const out = [...lines];
    const block = ["tags:", ...existing.map((t) => `  - ${t}`), ...newTags.map((t) => `  - ${t}`)];
    out.splice(i, 1, ...block);
    return out;
  }

  // Block-list form: append after last existing item
  let j = i + 1;
  while (j < lines.length && /^\s+-\s*/.test(lines[j])) j++;
  const out = [...lines];
  out.splice(j, 0, ...newTags.map((t) => `  - ${t}`));
  return out;
}

// ── Media path resolution (mirrors spike-uncensored-classifier.py covers() fn) ─
// For a note at <noteDir>/<platform>-<id>/ look for:
//   cover.jpg, video-poster.jpg, 1.jpg..N.jpg, video.mp4
// (also card-thumb.jpg, card.png, thumb.png from spike script — included for completeness)

const IMAGE_NAMES = [
  "cover.jpg",
  "video-poster.jpg",
  "card-thumb.jpg",
  "card.png",
  "thumb.png",
];
const VIDEO_NAMES = ["video.mp4"];
const KEYFRAME_COUNT = 12; // scan 1.jpg through 12.jpg

function resolveMediaPaths(noteDir, platform, itemId) {
  // Folder: <noteDir>/<platform>-<itemId>/
  const folder = join(noteDir, `${platform}-${itemId}`);
  if (!existsSync(folder)) return [];

  const paths = [];

  // Named cover images
  for (const name of IMAGE_NAMES) {
    const p = join(folder, name);
    if (existsSync(p)) paths.push(p);
  }

  // Keyframe sequence 1.jpg … N.jpg
  for (let i = 1; i <= KEYFRAME_COUNT; i++) {
    const p = join(folder, `${i}.jpg`);
    if (existsSync(p)) paths.push(p);
    else break; // stop at first gap (frames are contiguous)
  }

  // Video file (sidecar handles keyframe extraction)
  for (const name of VIDEO_NAMES) {
    const p = join(folder, name);
    if (existsSync(p)) paths.push(p);
  }

  return paths;
}

// ── Sidecar call ──────────────────────────────────────────────────────────────

async function classifyUncensored(paths) {
  const body = JSON.stringify({ paths });
  const res = await fetch(SIDECAR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body).toString() },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`sidecar ${res.status}: ${text}`);
  }
  const json = await res.json();
  if (!Array.isArray(json.results)) throw new Error(`unexpected sidecar response: ${JSON.stringify(json)}`);
  return json.results; // [{ path, score }, ...]
}

// ── Pure per-note backfill transform ──────────────────────────────────────────

/**
 * Pure: given a note's content, the max explicit-content score for its images,
 * and the category tag to add, return { content, changed, addedTag }.
 */
export function backfillNote(content, maxScore, catTag) {
  const fm = splitFm(content);
  if (!fm) return { content, changed: false, addedTag: null };

  const lines = fm.head.split("\n");
  const existingTags = new Set(readTags(lines));

  if (maxScore < UNCENSORED_THRESHOLD) return { content, changed: false, addedTag: null };
  if (existingTags.has(catTag)) return { content, changed: false, addedTag: null };

  const newLines = appendTags(lines, [catTag]);
  return {
    content: newLines.join("\n") + fm.rest,
    changed: true,
    addedTag: catTag,
  };
}

// ── Note metadata extraction ───────────────────────────────────────────────────

/**
 * Extract roost_id (returns { platform, itemId } or null), roost_category, and
 * collection/* tags from a note's frontmatter.
 */
export function parseNoteMeta(content) {
  const fm = splitFm(content);
  if (!fm) return null;

  const lines = fm.head.split("\n");
  const roostIdRaw = readKey(lines, "roost_id");
  if (!roostIdRaw) return null;

  // roost_id: platform:itemId
  const m = roostIdRaw.match(/^(\w+):(.+)$/);
  if (!m) return null;

  const roostCategory = readKey(lines, "roost_category");
  const tags = readTags(lines);
  const collectionTags = tags.filter((t) => t.startsWith("collection/"));

  return {
    platform: m[1],
    itemId: m[2],
    roostCategory,
    collectionTags,
    existingCategoryTags: tags.filter((t) => t.startsWith("category/")),
  };
}

/**
 * Check whether a note qualifies for uncensored backfill given the target category names.
 * A note qualifies if:
 *   - its roost_category matches one of the uncensored category names (case-insensitive), OR
 *   - any collection/* tag matches (collection/<slug> where slug matches a category name slug)
 */
export function noteMatchesUncensoredCategories(meta, categoryNames) {
  const targetSlugs = new Set(categoryNames.map(tagSlug));

  if (meta.roostCategory && targetSlugs.has(tagSlug(meta.roostCategory))) return true;

  for (const colTag of meta.collectionTags) {
    // collection/spicy → slug "spicy"
    const slug = colTag.replace(/^collection\//, "");
    if (targetSlugs.has(slug)) return true;
  }

  return false;
}

// ── Vault walker (mirrors migrate-to-tags.mjs) ────────────────────────────────

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue; // skip .roost, .obsidian, etc.
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");

  // --categories "Spicy" or --categories "Spicy,Adult" (comma-separated)
  const catIdx = args.indexOf("--categories");
  const categoriesRaw = catIdx !== -1 && args[catIdx + 1] ? args[catIdx + 1] : "Spicy";
  const categories = categoriesRaw.split(",").map((s) => s.trim()).filter(Boolean);

  const vault = args.find(
    (a) => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1]
  );
  if (!vault) {
    console.error(
      "usage: node scripts/backfill-uncensored-tags.mjs <vault-dir> [--categories \"Spicy\"] [--apply]"
    );
    process.exit(1);
  }

  console.log(`Uncensored backfill — categories: ${categories.join(", ")}`);
  console.log(`Mode: ${apply ? "APPLY (will write files)" : "DRY-RUN (no files written)"}`);
  console.log(`Sidecar: ${SIDECAR_URL}`);
  console.log(`Threshold: >= ${UNCENSORED_THRESHOLD}`);
  console.log("");

  // Sanity-check sidecar connectivity before walking the whole vault
  if (!apply) {
    console.log("Note: in dry-run mode the sidecar IS called to compute real scores.");
    console.log("      Pass --apply to actually write files.");
    console.log("");
  }

  console.log("Walking vault…");
  const files = await walk(vault);
  console.log(`  ${files.length} .md files found`);

  // ── Counters ───────────────────────────────────────────────────────────────
  let notesChecked = 0;       // notes with roost_id matching the categories
  let notesWithImages = 0;    // of those, notes where we found at least one image/video
  let notesWouldGainTag = 0;  // notes where score >= threshold and tag is absent
  let notesTagWritten = 0;    // notes where we actually wrote the file (only in --apply)
  let totalImagesFound = 0;
  let sidecarErrors = 0;

  // Per-category counters: catTag → would-gain count
  const gainPerCategory = {};
  for (const cat of categories) {
    gainPerCategory[categoryTag(cat)] = 0;
  }

  for (const f of files) {
    const content = readFileSync(f, "utf8");
    const meta = parseNoteMeta(content);
    if (!meta) continue;

    if (!noteMatchesUncensoredCategories(meta, categories)) continue;
    notesChecked++;

    const noteDir = f.replace(/\/[^/]+\.md$/, "");
    const mediaPaths = resolveMediaPaths(noteDir, meta.platform, meta.itemId);

    if (mediaPaths.length === 0) continue;
    notesWithImages++;
    totalImagesFound += mediaPaths.length;

    // POST to sidecar
    let results;
    try {
      results = await classifyUncensored(mediaPaths);
    } catch (err) {
      sidecarErrors++;
      console.error(`  [sidecar error] ${f}: ${err.message}`);
      continue;
    }

    const maxScore = Math.max(...results.map((r) => r.score ?? 0), 0);

    // Determine which category tags to add (there may be multiple categories)
    let anyGained = false;
    let newContent = content;
    for (const cat of categories) {
      const catTag = categoryTag(cat);
      const { content: updated, changed } = backfillNote(newContent, maxScore, catTag);
      if (changed) {
        newContent = updated;
        gainPerCategory[catTag] = (gainPerCategory[catTag] ?? 0) + 1;
        anyGained = true;
      }
    }

    if (anyGained) {
      notesWouldGainTag++;
      if (apply) {
        writeFileSync(f, newContent);
        notesTagWritten++;
      }
    }
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  const verb = apply ? "APPLIED" : "DRY-RUN";
  console.log("");
  console.log(`── ${verb} ─────────────────────────────────────────────`);
  console.log(`Notes matching uncensored categories:  ${notesChecked}`);
  console.log(`  with at least one image/video: ${notesWithImages}`);
  console.log(`  total images/videos found:     ${totalImagesFound}`);
  console.log(`  would gain category/* tag:     ${notesWouldGainTag}`);
  if (apply) {
    console.log(`  files written:                 ${notesTagWritten}`);
  }
  if (sidecarErrors > 0) {
    console.log(`  sidecar errors:                ${sidecarErrors}`);
  }
  console.log("");

  console.log("Breakdown by category tag:");
  for (const [catTag, count] of Object.entries(gainPerCategory)) {
    const label = apply ? "written" : "would gain";
    console.log(`  ${catTag.padEnd(30)} ${String(count).padStart(5)} notes ${label}`);
  }

  if (!apply) {
    console.log("");
    console.log("(dry-run — no files written; pass --apply to write)");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
