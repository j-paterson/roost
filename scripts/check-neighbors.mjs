#!/usr/bin/env node
import fs from "fs";
import path from "path";

const VAULT = path.join(process.env.HOME, "ObsidianBookmarks");
const cache = JSON.parse(fs.readFileSync(path.join(VAULT, ".roost/embedding-cache.json"), "utf8"));

const collItems = new Map();
function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { scan(path.join(dir, e.name)); continue; }
    if (!e.name.endsWith(".md")) continue;
    try {
      const c = fs.readFileSync(path.join(dir, e.name), "utf8");
      const fm = c.match(/^---\n([\s\S]*?)\n---/);
      if (!fm) continue;
      const id = fm[1].match(/roost_id:\s*"?([^"\n]+)"?/);
      if (!id) continue;
      const cat = fm[1].match(/^collection:\s*(.+)/m) || fm[1].match(/^roost_category:\s*(.+)/m);
      if (!cat) continue;
      const cn = cat[1].trim().replace(/^"|"$/g, "");
      if (cn && cn !== "undefined") {
        if (!collItems.has(cn)) collItems.set(cn, []);
        collItems.get(cn).push(id[1].trim());
      }
    } catch {}
  }
}
scan(path.join(VAULT, "Bookmarks"));

function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function mag(a) { return Math.sqrt(dot(a, a)); }
function cos(a, b) { return dot(a, b) / ((mag(a) || 1) * (mag(b) || 1)); }
function centroid(vecs) { const d = vecs[0].length; const c = new Array(d).fill(0); for (const v of vecs) for (let i = 0; i < d; i++) c[i] += v[i]; for (let i = 0; i < d; i++) c[i] /= vecs.length; return c; }

const centroids = new Map();
for (const [name, ids] of collItems) {
  const vecs = ids.filter(id => cache[id]?.vec).map(id => cache[id].vec);
  if (vecs.length > 0) centroids.set(name, centroid(vecs));
}

for (const target of ["Fashion", "Tattoo"]) {
  const tc = centroids.get(target);
  if (!tc) { console.log(target + ": not found"); continue; }
  const nb = [];
  for (const [name, c] of centroids) {
    if (name === target) continue;
    nb.push({ name, sim: cos(tc, c) });
  }
  nb.sort((a, b) => b.sim - a.sim);
  console.log(target + " nearest neighbors:");
  for (const n of nb.slice(0, 10)) console.log("  " + n.name.padEnd(20) + n.sim.toFixed(4));
  console.log();
}
