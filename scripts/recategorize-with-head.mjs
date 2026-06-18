// scripts/recategorize-with-head.mjs
// One-time: re-classify auto-assigned vault notes using the trained classifier head.
// Loads classifier-head.json + embedding-cache.json (+ embedding-vectors.bin), walks
// vault .md files, and for each item with roost_assigned_by==auto AND a cached vec:
//   - runs the head forward pass (x_l2norm → z=W·x+b → softmax → argmax)
//   - sets roost_category to the prediction
//   - if the predicted category differs from the old one, clears roost_subcategory
//     (orphaned sub under a new category); if unchanged, leaves roost_subcategory alone
// Only touches roost_assigned_by==auto items; human-assigned notes are never modified.
// DRY-RUN BY DEFAULT. Pass --apply to write changes.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

// ── Frontmatter helpers (line-oriented, same pattern as peer scripts) ──────────

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

function deleteKey(lines, key) {
  const i = lines.findIndex((x) => new RegExp(`^${key}\\s*:`).test(x));
  if (i >= 0) lines.splice(i, 1);
}

// ── Embedding cache loader (JS port of honest_eval_lib.load_cache) ─────────────
// Reads embedding-vectors.bin (newline-delimited JSON key list + float32 matrix)
// and merges inline vec entries from embedding-cache.json.

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
    const raw = readFileSync(binPath); // Buffer
    const nl = raw.indexOf(0x0a); // first newline
    const keys = JSON.parse(raw.slice(0, nl).toString("utf8"));
    const start = nl + 1;
    const bytesPerVec = dim * 4; // float32
    for (let i = 0; i < keys.length; i++) {
      const offset = start + i * bytesPerVec;
      // slice copies the bytes into a fresh, 4-byte-aligned ArrayBuffer
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

// ── Classifier head forward pass (mirrors classifier-head.ts EXACTLY) ──────────

function l2Normalize(vec) {
  let norm = 0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return new Float32Array(vec);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

function softmax(z) {
  let max = -Infinity;
  for (const v of z) if (v > max) max = v;
  let sum = 0;
  const exp = new Float32Array(z.length);
  for (let i = 0; i < z.length; i++) {
    exp[i] = Math.exp(z[i] - max);
    sum += exp[i];
  }
  for (let i = 0; i < exp.length; i++) exp[i] /= sum;
  return exp;
}

function classifyWithHead(vec, head) {
  const xNorm = l2Normalize(vec);
  const C = head.classes.length;
  const z = new Float32Array(C);
  for (let c = 0; c < C; c++) {
    let dot = 0;
    const row = head.W[c];
    for (let d = 0; d < row.length; d++) dot += row[d] * xNorm[d];
    z[c] = dot + head.b[c];
  }
  const p = softmax(z);
  let argmax = 0;
  let maxP = p[0];
  for (let c = 1; c < C; c++) {
    if (p[c] > maxP) { maxP = p[c]; argmax = c; }
  }
  return { category: head.classes[argmax], confidence: maxP };
}

// ── Pure per-note transform ────────────────────────────────────────────────────

/**
 * Pure: apply the classifier head prediction to one note's content.
 * Returns { content, changed, oldCat, newCat }.
 * Only modifies roost_assigned_by==auto notes with a cached vec.
 * Mirrors resortPatch subcategory logic: clear if category changes, else leave alone.
 */
export function recategorizeNote(content, roostId, head, embCache) {
  const fm = splitFm(content);
  if (!fm) return { content, changed: false, oldCat: null, newCat: null };

  const lines = fm.head.split("\n");
  const assignedBy = readKey(lines, "roost_assigned_by");
  if (assignedBy !== "auto") return { content, changed: false, oldCat: null, newCat: null };

  const vec = embCache.get(roostId);
  if (!vec) return { content, changed: false, oldCat: null, newCat: null };

  const { category: newCat } = classifyWithHead(vec, head);
  const oldCat = readKey(lines, "roost_category");
  const oldSub = readKey(lines, "roost_subcategory");

  // Determine what changes are needed
  const catChanges = newCat !== oldCat;
  // If category changes, subcategory is orphaned → clear it
  // If category stays the same, leave subcategory untouched
  const clearSub = catChanges && oldSub !== null;

  if (!catChanges && !clearSub) return { content, changed: false, oldCat, newCat };

  setKey(lines, "roost_category", newCat);
  if (clearSub) deleteKey(lines, "roost_subcategory");

  return {
    content: lines.join("\n") + fm.rest,
    changed: true,
    oldCat: oldCat ?? "(none)",
    newCat,
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
    console.error("usage: node scripts/recategorize-with-head.mjs <vault-dir> [--apply]");
    process.exit(1);
  }

  const cacheDir = join(vault, ".roost", "cache");
  const headPath = join(cacheDir, "classifier-head.json");

  if (!existsSync(headPath)) {
    console.error(`classifier-head.json not found at ${headPath}`);
    process.exit(1);
  }

  console.log("Loading classifier head…");
  const head = JSON.parse(readFileSync(headPath, "utf8"));
  if (
    head.version !== 1 ||
    head.norm !== "l2" ||
    !Array.isArray(head.classes) ||
    !Array.isArray(head.W) ||
    !Array.isArray(head.b)
  ) {
    console.error("classifier-head.json failed structural validation");
    process.exit(1);
  }
  console.log(`  ${head.classes.length} classes, dim=${head.dim}, trainedOn=${head.trainedOn}`);

  console.log("Loading embedding cache…");
  const embCache = loadEmbeddingCache(cacheDir);
  console.log(`  ${embCache.size} cached vectors`);

  console.log("Walking vault…");
  const files = await walk(vault);

  // Counters
  let totalAuto = 0;
  let withVec = 0;
  let wouldChange = 0;

  // Distribution maps: category → count (auto items with vec, before and after)
  const beforeDist = {};
  const afterDist = {};

  for (const f of files) {
    const before = readFileSync(f, "utf8");
    const roostId = readRoostId(before);
    if (!roostId) continue;

    // Quick check: is it an auto note?
    const fm = splitFm(before);
    if (!fm) continue;
    const lines = fm.head.split("\n");
    const assignedBy = readKey(lines, "roost_assigned_by");
    if (assignedBy !== "auto") continue;

    totalAuto++;

    const vec = embCache.get(roostId);
    if (!vec) continue;
    withVec++;

    const oldCat = readKey(lines, "roost_category") ?? "(none)";
    beforeDist[oldCat] = (beforeDist[oldCat] ?? 0) + 1;

    const { content, changed, newCat } = recategorizeNote(before, roostId, head, embCache);
    const resolvedNewCat = newCat ?? oldCat;
    afterDist[resolvedNewCat] = (afterDist[resolvedNewCat] ?? 0) + 1;

    if (changed) {
      wouldChange++;
      if (apply) writeFileSync(f, content);
    }
  }

  // Report
  const verb = apply ? "changed" : "would change";
  console.log("");
  console.log(`Auto items in vault:        ${totalAuto}`);
  console.log(`  with cached embedding:    ${withVec}`);
  console.log(`  ${verb} category:         ${wouldChange}`);
  console.log("");

  const allCats = new Set([...Object.keys(beforeDist), ...Object.keys(afterDist)]);
  const rows = [...allCats].sort().map((cat) => {
    const b = beforeDist[cat] ?? 0;
    const a = afterDist[cat] ?? 0;
    const delta = a - b;
    const sign = delta > 0 ? "+" : "";
    return `  ${cat.padEnd(20)} before: ${String(b).padStart(5)}  after: ${String(a).padStart(5)}  (${sign}${delta})`;
  });
  console.log("Category distribution (auto items with vec):");
  for (const row of rows) console.log(row);

  if (!apply) {
    console.log("");
    console.log("(dry-run; pass --apply to write)");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
