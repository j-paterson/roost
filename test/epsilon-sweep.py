"""
Epsilon sweep — test cluster_selection_epsilon values for taxonomy HDBSCAN.
Embeds categories once, sweeps epsilon 0.0–0.8, measures downstream cluster purity.
Generates interactive HTML report.

Usage: python test/epsilon-sweep.py
"""
import json, time, sys, urllib.request
from pathlib import Path
from collections import Counter

import numpy as np
import hdbscan

HOME = Path.home()
CACHE_PATH = HOME / "ObsidianBookmarks/.roost/embedding-cache.json"
CLUSTER_RESULTS = Path("/tmp/roost-cluster-full.json")
OUT_HTML = Path(__file__).parent / "epsilon-sweep.html"
OLLAMA = "http://localhost:11434"

def log(msg): print(msg, file=sys.stderr, flush=True)

# ── Load data ──
log("Loading embedding cache...")
cache = json.load(open(CACHE_PATH))

if not CLUSTER_RESULTS.exists():
    log("ERROR: Run 'node test/full-pipeline.mjs' first to generate /tmp/roost-cluster-full.json")
    sys.exit(1)
cluster_data = json.load(open(CLUSTER_RESULTS))
item_ids = cluster_data["ids"]
item_labels = cluster_data["labels"]
item_cluster_ids = sorted(set(l for l in item_labels if l >= 0))

# ── Step 1: Extract and embed categories ──
cat_counts = Counter()
for v in cache.values():
    if not v or not v.get("vec"): continue
    c = (v.get("category") or "").strip().rstrip(".").lower()
    if c: cat_counts[c] += 1

cats = [(c, n) for c, n in cat_counts.most_common() if n >= 2]
cat_strings = [c for c, _ in cats]
log(f"{len(cats)} categories with 2+ items")

log("Embedding categories...")
t0 = time.time()
cat_vecs = []
for i, cat in enumerate(cat_strings):
    req = urllib.request.Request(
        f"{OLLAMA}/api/embed",
        data=json.dumps({"model": "nomic-embed-text", "input": cat}).encode(),
        headers={"Content-Type": "application/json"},
    )
    resp = urllib.request.urlopen(req)
    data = json.loads(resp.read())
    cat_vecs.append(data["embeddings"][0])
    if (i + 1) % 100 == 0: log(f"  {i+1}/{len(cat_strings)}")
cat_vecs_np = np.array(cat_vecs, dtype=np.float32)
log(f"Embedded {len(cat_vecs)} categories in {time.time()-t0:.1f}s")

# ── Step 2: Sweep epsilon ──
epsilons = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
results = []

def resolve(mapping, raw_cat):
    n = (raw_cat or "").strip().rstrip(".").lower()
    return mapping.get(n, n.title() if n else "")

for eps in epsilons:
    log(f"\n═══ epsilon={eps:.1f} ═══")

    # Base HDBSCAN clustering (same every time)
    clusterer = hdbscan.HDBSCAN(min_cluster_size=2, metric="euclidean")
    labels = clusterer.fit_predict(cat_vecs_np).copy()

    # Collect cluster members
    cluster_members = {}
    for i, l in enumerate(labels):
        if l < 0: continue
        if l not in cluster_members: cluster_members[l] = []
        cluster_members[l].append(i)

    # Post-merge: merge clusters whose centroids have cosine sim > (1 - epsilon)
    if eps > 0 and len(cluster_members) > 1:
        cl_ids = list(cluster_members.keys())
        centroids = {}
        for cl_id, indices in cluster_members.items():
            centroids[cl_id] = cat_vecs_np[indices].mean(axis=0)

        # Union-find
        parent = {c: c for c in cl_ids}
        def find(x):
            while parent[x] != x: parent[x] = parent[parent[x]]; x = parent[x]
            return x
        def union(a, b):
            ra, rb = find(a), find(b)
            if ra != rb: parent[ra] = rb

        threshold = 1 - eps
        for i in range(len(cl_ids)):
            for j in range(i+1, len(cl_ids)):
                ci, cj = centroids[cl_ids[i]], centroids[cl_ids[j]]
                sim = float(np.dot(ci, cj) / (np.linalg.norm(ci) * np.linalg.norm(cj) + 1e-10))
                if sim > threshold:
                    union(cl_ids[i], cl_ids[j])

        # Rebuild merged clusters
        merged = {}
        for cl_id, indices in cluster_members.items():
            root = find(cl_id)
            if root not in merged: merged[root] = []
            merged[root].extend(indices)
        cluster_members = merged

        # Absorb noise near merged centroids
        merged_centroids = {}
        for cl_id, indices in cluster_members.items():
            merged_centroids[cl_id] = cat_vecs_np[indices].mean(axis=0)
        for i in range(len(labels)):
            if labels[i] >= 0: continue
            best_cl, best_sim = -1, -np.inf
            for cl_id, cent in merged_centroids.items():
                sim = float(np.dot(cat_vecs_np[i], cent) / (np.linalg.norm(cat_vecs_np[i]) * np.linalg.norm(cent) + 1e-10))
                if sim > best_sim: best_sim = sim; best_cl = cl_id
            if best_sim > threshold:
                cluster_members[best_cl].append(i)
                labels[i] = best_cl

    cluster_ids = sorted(cluster_members.keys())
    noise_count = int(np.sum(labels == -1))

    # Build mapping
    mapping = {}
    merge_groups = {}
    for cl_id, indices in cluster_members.items():
        members = [(cat_strings[i], cat_counts[cat_strings[i]]) for i in indices]
        members.sort(key=lambda x: -x[1])
        canonical = members[0][0].title()
        for m, n in members:
            mapping[m] = canonical
        if len(members) > 1:
            merge_groups[canonical] = members

    for i in range(len(labels)):
        if labels[i] < 0:
            mapping[cat_strings[i]] = cat_strings[i].title()

    canonical_count = len(set(mapping.values()))
    merged_count = len(mapping) - canonical_count

    # Measure downstream purity on bookmark clusters
    raw_purities = []
    taxo_purities = []
    for cl in item_cluster_ids:
        member_ids = [item_ids[i] for i in range(len(item_ids)) if item_labels[i] == cl]
        raw_cats = Counter(cache.get(id, {}).get("category", "") or "" for id in member_ids)
        taxo_cats = Counter(resolve(mapping, cache.get(id, {}).get("category", "")) for id in member_ids)
        raw_purities.append(raw_cats.most_common(1)[0][1] / len(member_ids))
        taxo_purities.append(taxo_cats.most_common(1)[0][1] / len(member_ids))

    avg_raw = sum(raw_purities) / len(raw_purities)
    avg_taxo = sum(taxo_purities) / len(taxo_purities)
    purity_50 = sum(1 for p in taxo_purities if p >= 0.5)
    purity_40 = sum(1 for p in taxo_purities if p >= 0.4)
    purity_30 = sum(1 for p in taxo_purities if p >= 0.3)

    # Top merges by total items affected
    top_merges = sorted(merge_groups.items(), key=lambda x: -sum(n for _, n in x[1]))[:10]
    top_merge_strs = []
    for canonical, members in top_merges:
        member_str = ", ".join(f"{m}({n})" for m, n in members[:5])
        total = sum(n for _, n in members)
        top_merge_strs.append({"canonical": canonical, "total": total, "members": member_str, "count": len(members)})

    # All merges for detail view
    all_merges = []
    for canonical, members in sorted(merge_groups.items(), key=lambda x: -sum(n for _, n in x[1])):
        total = sum(n for _, n in members)
        member_str = ", ".join(f"{m}({n})" for m, n in members)
        all_merges.append({"canonical": canonical, "total": total, "members": member_str, "count": len(members)})

    log(f"  {len(cluster_ids)} cat clusters, {noise_count} noise, {canonical_count} canonical, {merged_count} merged")
    log(f"  Purity: raw {avg_raw:.1%} → taxo {avg_taxo:.1%} (Δ +{avg_taxo-avg_raw:.1%})")
    log(f"  ≥50%: {purity_50}, ≥40%: {purity_40}, ≥30%: {purity_30}")

    results.append({
        "epsilon": eps,
        "cat_clusters": len(cluster_ids),
        "cat_noise": noise_count,
        "canonical_count": canonical_count,
        "merged_count": merged_count,
        "avg_purity_raw": round(avg_raw, 4),
        "avg_purity_taxo": round(avg_taxo, 4),
        "purity_delta": round(avg_taxo - avg_raw, 4),
        "purity_50": purity_50,
        "purity_40": purity_40,
        "purity_30": purity_30,
        "top_merges": top_merge_strs,
        "all_merges": all_merges,
    })

# ── Step 3: Generate HTML ──
log(f"\nWriting {OUT_HTML}...")

html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Taxonomy Epsilon Sweep</title>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ font-family: -apple-system, system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 24px; }}
  h1 {{ font-size: 20px; margin-bottom: 4px; }}
  .subtitle {{ color: #888; font-size: 13px; margin-bottom: 24px; }}
  .chart-container {{ display: flex; gap: 24px; margin-bottom: 24px; }}
  .chart {{ flex: 1; background: #16213e; border-radius: 8px; padding: 16px; border: 1px solid #333; }}
  .chart h3 {{ font-size: 13px; color: #999; margin-bottom: 12px; }}
  canvas {{ width: 100%; height: 200px; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
  th {{ text-align: left; padding: 8px 12px; border-bottom: 2px solid #444; color: #999; font-weight: 600; }}
  td {{ padding: 8px 12px; border-bottom: 1px solid #333; }}
  tr {{ cursor: pointer; }}
  tr:hover {{ background: #1a2744; }}
  tr.selected {{ background: #1a3355; }}
  .purity {{ font-weight: 600; }}
  .good {{ color: #4ade80; }}
  .ok {{ color: #facc15; }}
  .bad {{ color: #f87171; }}
  .bar {{ display: inline-block; height: 14px; border-radius: 2px; vertical-align: middle; }}
  .bar-purity {{ background: #7ec8e3; }}
  .bar-raw {{ background: #555; }}
  .detail {{ margin-top: 24px; background: #16213e; border-radius: 8px; padding: 16px; border: 1px solid #333; display: none; }}
  .detail h3 {{ font-size: 14px; margin-bottom: 12px; }}
  .merge-list {{ max-height: 400px; overflow-y: auto; }}
  .merge-item {{ padding: 4px 0; border-bottom: 1px solid #2a2a4a; font-size: 12px; }}
  .merge-canonical {{ color: #7ec8e3; font-weight: 600; }}
  .merge-members {{ color: #999; margin-left: 8px; }}
  .merge-count {{ color: #666; font-size: 11px; }}
  .summary {{ display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }}
  .stat-card {{ background: #1a2744; border-radius: 6px; padding: 12px 16px; border: 1px solid #333; min-width: 120px; }}
  .stat-card .label {{ font-size: 11px; color: #888; }}
  .stat-card .value {{ font-size: 20px; font-weight: 700; color: #fff; }}
  .manual-ref {{ color: #666; font-style: italic; font-size: 12px; }}
</style>
</head>
<body>
<h1>Taxonomy Epsilon Sweep</h1>
<div class="subtitle">
  HDBSCAN cluster_selection_epsilon on {len(cats)} category embeddings → downstream purity on {len(item_cluster_ids)} bookmark clusters
  <br><span class="manual-ref">Manual rules baseline: 46.1% avg purity, 59/102 ≥40%</span>
</div>

<div class="chart-container">
  <div class="chart">
    <h3>Avg Purity by Epsilon</h3>
    <canvas id="chart-purity"></canvas>
  </div>
  <div class="chart">
    <h3>Canonical Categories / Merges</h3>
    <canvas id="chart-cats"></canvas>
  </div>
</div>

<table id="results-table">
  <thead>
    <tr>
      <th>ε</th>
      <th>Cat Clusters</th>
      <th>Canonical</th>
      <th>Merged</th>
      <th>Raw Purity</th>
      <th>Taxo Purity</th>
      <th>Δ</th>
      <th>≥50%</th>
      <th>≥40%</th>
      <th>≥30%</th>
      <th>Top Merge</th>
    </tr>
  </thead>
  <tbody id="results-body"></tbody>
</table>

<div class="detail" id="detail-panel">
  <div class="summary" id="detail-summary"></div>
  <h3 id="detail-title">Merges at ε=0.0</h3>
  <div class="merge-list" id="merge-list"></div>
</div>

<script>
const results = {json.dumps(results)};
const manualPurity = 0.461;

// Render table
const tbody = document.getElementById("results-body");
results.forEach((r, i) => {{
  const purityClass = r.avg_purity_taxo >= 0.45 ? "good" : r.avg_purity_taxo >= 0.35 ? "ok" : "bad";
  const topMerge = r.top_merges[0] ? `${{r.top_merges[0].canonical}} (${{r.top_merges[0].count}} merged)` : "—";
  const barW = Math.round(r.avg_purity_taxo * 200);
  const rawW = Math.round(r.avg_purity_raw * 200);
  const tr = document.createElement("tr");
  tr.dataset.index = i;
  tr.innerHTML = `
    <td><strong>${{r.epsilon.toFixed(1)}}</strong></td>
    <td>${{r.cat_clusters}}</td>
    <td>${{r.canonical_count}}</td>
    <td>${{r.merged_count}}</td>
    <td>${{(r.avg_purity_raw * 100).toFixed(1)}}%</td>
    <td class="purity ${{purityClass}}">${{(r.avg_purity_taxo * 100).toFixed(1)}}%</td>
    <td>+${{(r.purity_delta * 100).toFixed(1)}}%</td>
    <td>${{r.purity_50}}/102</td>
    <td>${{r.purity_40}}/102</td>
    <td>${{r.purity_30}}/102</td>
    <td style="font-size:11px;color:#888">${{topMerge}}</td>
  `;
  tr.onclick = () => showDetail(i);
  tbody.appendChild(tr);
}});

function showDetail(idx) {{
  const r = results[idx];
  document.querySelectorAll("#results-body tr").forEach(tr => tr.classList.remove("selected"));
  document.querySelector(`#results-body tr[data-index="${{idx}}"]`).classList.add("selected");

  const panel = document.getElementById("detail-panel");
  panel.style.display = "block";
  document.getElementById("detail-title").textContent = `All merges at ε=${{r.epsilon.toFixed(1)}} (${{r.all_merges.length}} groups)`;

  const summary = document.getElementById("detail-summary");
  summary.innerHTML = `
    <div class="stat-card"><div class="label">Avg Purity</div><div class="value">${{(r.avg_purity_taxo * 100).toFixed(1)}}%</div></div>
    <div class="stat-card"><div class="label">Canonical Categories</div><div class="value">${{r.canonical_count}}</div></div>
    <div class="stat-card"><div class="label">Categories Merged</div><div class="value">${{r.merged_count}}</div></div>
    <div class="stat-card"><div class="label">≥40% Purity</div><div class="value">${{r.purity_40}}/102</div></div>
  `;

  const list = document.getElementById("merge-list");
  list.innerHTML = "";
  for (const m of r.all_merges) {{
    const div = document.createElement("div");
    div.className = "merge-item";
    div.innerHTML = `<span class="merge-canonical">${{m.canonical}}</span> <span class="merge-count">(${{m.total}} items, ${{m.count}} merged)</span><br><span class="merge-members">← ${{m.members}}</span>`;
    list.appendChild(div);
  }}
}}

// Charts
function drawLineChart(canvasId, datasets) {{
  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = (rect.width - 32) * dpr;
  canvas.height = 200 * dpr;
  canvas.style.width = (rect.width - 32) + "px";
  canvas.style.height = "200px";
  ctx.scale(dpr, dpr);
  const W = rect.width - 32, H = 200, pad = {{top: 10, right: 50, bottom: 30, left: 50}};
  const plotW = W - pad.left - pad.right, plotH = H - pad.top - pad.bottom;

  // Find global min/max across all datasets
  let allVals = [];
  for (const ds of datasets) allVals.push(...ds.values);
  if (datasets.some(ds => ds.refLine !== undefined)) allVals.push(...datasets.filter(ds => ds.refLine !== undefined).map(ds => ds.refLine));
  let minY = Math.min(...allVals) * 0.9, maxY = Math.max(...allVals) * 1.1;

  const xs = results.map((_, i) => pad.left + (i / (results.length - 1)) * plotW);

  // Grid
  ctx.strokeStyle = "#333"; ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {{
    const y = pad.top + (i / 4) * plotH;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    ctx.fillStyle = "#666"; ctx.font = "10px sans-serif"; ctx.textAlign = "right";
    const val = maxY - (i / 4) * (maxY - minY);
    ctx.fillText(val >= 1 ? val.toFixed(0) : (val * 100).toFixed(0) + "%", pad.left - 8, y + 4);
  }}

  // X labels
  ctx.fillStyle = "#666"; ctx.textAlign = "center";
  results.forEach((r, i) => {{
    ctx.fillText(r.epsilon.toFixed(1), xs[i], H - 8);
  }});

  // Lines
  for (const ds of datasets) {{
    // Reference line
    if (ds.refLine !== undefined) {{
      const refY = pad.top + (1 - (ds.refLine - minY) / (maxY - minY)) * plotH;
      ctx.strokeStyle = ds.color + "44"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(pad.left, refY); ctx.lineTo(W - pad.right, refY); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ds.color + "88"; ctx.font = "10px sans-serif"; ctx.textAlign = "left";
      ctx.fillText(ds.refLabel || "", W - pad.right + 4, refY + 4);
    }}

    ctx.strokeStyle = ds.color; ctx.lineWidth = 2;
    ctx.beginPath();
    ds.values.forEach((v, i) => {{
      const y = pad.top + (1 - (v - minY) / (maxY - minY)) * plotH;
      if (i === 0) ctx.moveTo(xs[i], y); else ctx.lineTo(xs[i], y);
    }});
    ctx.stroke();

    // Points
    ds.values.forEach((v, i) => {{
      const y = pad.top + (1 - (v - minY) / (maxY - minY)) * plotH;
      ctx.fillStyle = ds.color;
      ctx.beginPath(); ctx.arc(xs[i], y, 4, 0, Math.PI * 2); ctx.fill();
    }});

    // Label
    const lastY = pad.top + (1 - (ds.values[ds.values.length-1] - minY) / (maxY - minY)) * plotH;
    ctx.fillStyle = ds.color; ctx.font = "11px sans-serif"; ctx.textAlign = "left";
    ctx.fillText(ds.label, W - pad.right + 4, lastY + 4);
  }}
}}

drawLineChart("chart-purity", [
  {{ label: "Taxo", values: results.map(r => r.avg_purity_taxo), color: "#7ec8e3", refLine: 0.461, refLabel: "manual" }},
  {{ label: "Raw", values: results.map(r => r.avg_purity_raw), color: "#666" }},
]);

drawLineChart("chart-cats", [
  {{ label: "Canonical", values: results.map(r => r.canonical_count), color: "#a78bfa" }},
  {{ label: "Merged", values: results.map(r => r.merged_count), color: "#f97316" }},
]);

// Auto-select first row
showDetail(0);
</script>
</body>
</html>"""

with open(OUT_HTML, "w") as f:
    f.write(html)

log(f"\nDone! Open: file://{OUT_HTML}")
