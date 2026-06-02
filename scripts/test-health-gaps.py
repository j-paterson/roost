#!/usr/bin/env python3
"""Comprehensive test of collection-health audit + gap-detection.

Loads real production data:
  - ~/ObsidianBookmarks/.roost/embedding-cache.json    (18K item cache)
  - vault frontmatter                                  (current collection labels)
  - ~/ObsidianBookmarks/.roost/score-cache.json        (5960 cached rerank decisions)

Then:
  1. Runs leave-one-out collection-health audit.
     Ports the TypeScript logic in src/pipeline/collection-health.ts.

  2. For gap-detection, recomputes the *real* picked-sim for every cached
     score entry by taking cosine(item_vec, assigned_collection_centroid).
     Runs gap-detection with the OLD integer-score logic AND the NEW
     sim-threshold logic, printing the diff so we can see exactly which
     items the blind-band fix catches.

  3. Runs gap-detection end-to-end and prints the cohort report.

No LLM calls. All pure math. Should run in <10 seconds.
"""
import json
import math
import re
import sys
from collections import defaultdict, Counter
from pathlib import Path

VAULT = Path.home() / "ObsidianBookmarks"
ROOST = VAULT / ".roost"
BOOKMARKS = VAULT / "Bookmarks"

# Health-audit constants (match collection-health.ts)
MIN_MEMBERS = 5
LOO_ACC_WARN = 0.60
COHESION_WARN = 0.55

# Gap-detection constants (match gap-detection.ts after fix)
WEAK_SIM_MAX_NEW = 0.87
WEAK_SCORE_MAX_OLD = 8  # old integer-score threshold
MIN_COHORT_SIZE = 8
MIN_COHORT_COHESION = 0.55


# ── Math helpers ──────────────────────────────────────────────

def dot(a, b):
    s = 0.0
    for i in range(len(a)):
        s += a[i] * b[i]
    return s


def mag(a):
    return math.sqrt(dot(a, a))


def cosine(a, b):
    return dot(a, b) / ((mag(a) or 1) * (mag(b) or 1))


def centroid(vecs):
    d = len(vecs[0])
    c = [0.0] * d
    for v in vecs:
        for i in range(d):
            c[i] += v[i]
    for i in range(d):
        c[i] /= len(vecs)
    return c


def cohesion(vecs, c):
    if not vecs:
        return 0.0
    return sum(cosine(v, c) for v in vecs) / len(vecs)


# ── Load data ─────────────────────────────────────────────────

print("Loading embedding cache...")
with open(ROOST / "embedding-cache.json") as f:
    cache = json.load(f)
print(f"  {len(cache):,} items in cache")

print("Scanning vault for collection labels...")
collections = defaultdict(list)
fm_re = re.compile(r"^---\n([\s\S]*?)\n---", re.MULTILINE)
id_re = re.compile(r'roost_id:\s*"?([^"\n]+)"?')
cat_re = re.compile(r'^roost_category:\s*(.+)', re.MULTILINE)
coll_re = re.compile(r'^collection:\s*(.+)', re.MULTILINE)

scanned = 0
for md_file in BOOKMARKS.rglob("*.md"):
    scanned += 1
    try:
        content = md_file.read_text(encoding="utf-8")
    except Exception:
        continue
    fm_match = fm_re.match(content)
    if not fm_match:
        continue
    fm = fm_match.group(1)
    id_match = id_re.search(fm)
    if not id_match:
        continue
    iid = id_match.group(1).strip()
    cat_match = cat_re.search(fm) or coll_re.search(fm)
    if not cat_match:
        continue
    cat = cat_match.group(1).strip().strip('"').strip("'")
    if cat and cat not in ("undefined", "null"):
        collections[cat].append(iid)

print(f"  scanned {scanned:,} files, found {len(collections)} collections")
total_labeled = sum(len(v) for v in collections.values())
print(f"  {total_labeled:,} labeled items")


# ── PART 1: Collection Health Audit ──────────────────────────

print("\n" + "=" * 90)
print("PART 1: Collection Health Audit (LOO)")
print("=" * 90)

# Gather vectors per collection
vecs = {}
for name, ids in collections.items():
    vs = [(iid, cache[iid]["vec"]) for iid in ids if iid in cache and cache[iid].get("vec")]
    if vs:
        vecs[name] = vs

names = list(vecs.keys())
print(f"  {len(names)} collections have cached vectors")

# Precompute full centroids
full_centroids = {name: centroid([v for _, v in vecs[name]]) for name in names}

reports = []
total_correct = 0
total_members = 0

for name in names:
    members = vecs[name]
    n = len(members)
    coh = cohesion([v for _, v in members], full_centroids[name])

    if n < 2:
        reports.append({
            "name": name, "n": n, "loo_acc": 0.0, "cohesion": coh,
            "confusions": [], "status": "small",
        })
        continue

    correct = 0
    confusion = Counter()
    for i, (held_id, held_vec) in enumerate(members):
        rest = [v for j, (_, v) in enumerate(members) if j != i]
        home_centroid = centroid(rest)
        best_name = name
        best_sim = cosine(held_vec, home_centroid)
        for other in names:
            if other == name:
                continue
            s = cosine(held_vec, full_centroids[other])
            if s > best_sim:
                best_sim = s
                best_name = other
        if best_name == name:
            correct += 1
        else:
            confusion[best_name] += 1

    loo_acc = correct / n
    total_correct += correct
    total_members += n
    top_confusions = confusion.most_common(3)

    status = "healthy"
    if n < MIN_MEMBERS:
        status = "small"
    elif loo_acc < LOO_ACC_WARN or coh < COHESION_WARN:
        status = "polluted"
    elif top_confusions and top_confusions[0][1] >= max(2, math.ceil(n * 0.3)):
        status = "confused"

    reports.append({
        "name": name, "n": n, "loo_acc": loo_acc, "cohesion": coh,
        "confusions": top_confusions, "status": status,
    })

global_loo = total_correct / total_members if total_members else 1.0

# Print
print(f"\n  Global LOO accuracy: {global_loo*100:.1f}%  ({total_members:,} labeled items across {len(names)} collections)\n")
sorted_reports = sorted(reports, key=lambda r: r["loo_acc"])
print(f"  {'name':<32}  {'n':>4}  {'LOO%':>5}  {'cohes':>5}  {'status':<9}  top confusion")
print("  " + "-" * 88)
for r in sorted_reports:
    name = (r["name"][:32]).ljust(32)
    n_str = f"{r['n']:>4}"
    loo_str = (f"{round(r['loo_acc']*100)}%" if r["n"] >= 2 else "—").rjust(5)
    coh_str = f"{r['cohesion']:.2f}"
    status = r["status"].ljust(9)
    conf = f"→ {r['confusions'][0][0]} ({r['confusions'][0][1]})" if r["confusions"] else ""
    print(f"  {name}  {n_str}  {loo_str}   {coh_str}   {status}  {conf}")

# Summary by status
status_counts = Counter(r["status"] for r in reports)
print(f"\n  Status summary: " + "  ".join(f"{k}={v}" for k, v in sorted(status_counts.items())))

unhealthy = [r for r in reports if r["status"] != "healthy"]
if unhealthy:
    print(f"\n  {len(unhealthy)} collection(s) need attention:")
    for r in unhealthy:
        if r["status"] == "small":
            print(f"    • {r['name']}: only {r['n']} member(s) — centroid is noisy")
        elif r["status"] == "polluted":
            drift = f" (drifting to {r['confusions'][0][0]})" if r["confusions"] else ""
            print(f"    • {r['name']}: LOO {round(r['loo_acc']*100)}%, cohesion {r['cohesion']:.2f}{drift}")
        elif r["status"] == "confused":
            t, c = r["confusions"][0]
            print(f"    • {r['name']}: {c}/{r['n']} prefer \"{t}\" — consider merging")


# ── PART 2: Blind-band fix verification on real score cache ──

print("\n" + "=" * 90)
print("PART 2: Blind-band Fix Verification (sim < 0.87 vs score <= 8)")
print("=" * 90)

print("Loading score cache...")
with open(ROOST / "score-cache.json") as f:
    score_cache = json.load(f)
print(f"  {len(score_cache):,} cached score entries")

# For each cached entry, recompute the ACTUAL sim against the assigned
# collection's centroid (full centroid, not LOO). This gives us the
# real picked_sim that the LLM run would have stored under the new schema.
match_details_new = {}  # id → {"collection", "score", "sim"}
match_details_old = {}  # id → {"collection", "score"}  (score-based only)
missing_item = 0
missing_coll = 0
hash_stripped = 0

for key, entry in score_cache.items():
    if entry is None:
        continue
    # Keys look like "tiktok:xxxx|hashXXXX" — strip the hash suffix
    iid = key.rsplit("|", 1)[0]
    cat = entry.get("cat")
    score = entry.get("score", 0)
    if not cat:
        continue
    if iid not in cache or not cache[iid].get("vec"):
        missing_item += 1
        continue
    if cat not in full_centroids:
        missing_coll += 1
        continue
    real_sim = cosine(cache[iid]["vec"], full_centroids[cat])
    match_details_new[iid] = {"collection": cat, "score": score, "sim": real_sim}
    match_details_old[iid] = {"collection": cat, "score": score}

print(f"  recomputed sims for {len(match_details_new):,} items")
print(f"  skipped: {missing_item:,} (item missing from cache), {missing_coll:,} (collection no longer exists)")

# Distribution of real sims
sim_buckets = Counter()
for d in match_details_new.values():
    b = round(d["sim"] * 20) / 20  # 0.05 buckets
    sim_buckets[b] += 1
print("\n  Real sim distribution (0.05 buckets):")
for b in sorted(sim_buckets):
    bar = "█" * int(sim_buckets[b] / 40)
    print(f"    {b:.2f}: {sim_buckets[b]:>5} {bar}")

# OLD logic: score <= 8 is weak
weak_old = {iid for iid, d in match_details_old.items() if d["score"] <= WEAK_SCORE_MAX_OLD}
# NEW logic: sim < 0.87 is weak
weak_new = {iid for iid, d in match_details_new.items() if d["sim"] < WEAK_SIM_MAX_NEW}

only_new = weak_new - weak_old
only_old = weak_old - weak_new
both = weak_new & weak_old

print(f"\n  Old logic (score<={WEAK_SCORE_MAX_OLD}): {len(weak_old):>5} weak items")
print(f"  New logic (sim<{WEAK_SIM_MAX_NEW}): {len(weak_new):>5} weak items")
print(f"    in both:         {len(both):>5}")
print(f"    only new catches:{len(only_new):>5}  ← items the blind-band fix RECOVERS")
print(f"    only old caught: {len(only_old):>5}  ← items the new logic excludes (real sim ≥ 0.87)")

# Show a few items the new logic uniquely catches (blind band) — these are
# items with real sim ∈ [sim_threshold, score_threshold_sim_equiv), i.e. the
# exact blind band.
if only_new:
    print("\n  Sample items the new logic RECOVERS (previously missed):")
    samples = list(only_new)[:8]
    for iid in samples:
        d = match_details_new[iid]
        summary = (cache[iid].get("summary", "") or "")[:60]
        print(f"    [{d['sim']:.3f} score={d['score']} → {d['collection']}] {summary}")

# And items only-old — these have integer score 8 but real sim >= 0.87
# (e.g. sim=0.875, round=9 historically was score 9 but score-cache rounded
# at a different moment)
if only_old:
    print("\n  Sample items the new logic EXCLUDES (real sim ≥ 0.87 but score ≤ 8):")
    samples = list(only_old)[:5]
    for iid in samples:
        d = match_details_new[iid]
        summary = (cache[iid].get("summary", "") or "")[:60]
        print(f"    [{d['sim']:.3f} score={d['score']} → {d['collection']}] {summary}")


# ── PART 3: Gap Detection on real data ─────────────────────

print("\n" + "=" * 90)
print("PART 3: Gap Detection — Missing Collections Report")
print("=" * 90)

# Group weak items (new logic) by their cached Ollama category
existing_lower = {n.lower() for n in names}
groups = defaultdict(list)
for iid in weak_new:
    cat = (cache[iid].get("category") or "").strip()
    if cat:
        groups[cat].append(iid)

print(f"\n  {len(weak_new):,} weak-match items grouped into {len(groups)} Ollama-category buckets")

cohorts = []
for cat, ids in groups.items():
    if len(ids) < MIN_COHORT_SIZE:
        continue
    if cat.lower() in existing_lower:
        continue  # category already exists as a collection
    vs = [cache[iid]["vec"] for iid in ids if iid in cache and cache[iid].get("vec")]
    if len(vs) < 2:
        continue
    c = centroid(vs)
    coh = cohesion(vs, c)
    if coh < MIN_COHORT_COHESION:
        continue
    # Top target collections
    targets = Counter()
    for iid in ids:
        t = match_details_new[iid]["collection"]
        if t:
            targets[t] += 1
    samples = []
    for iid in ids[:3]:
        s = (cache[iid].get("summary") or "")[:80]
        if s:
            samples.append(s)
    cohorts.append({
        "ollamaCategory": cat,
        "itemIds": ids,
        "targets": targets.most_common(3),
        "cohesion": coh,
        "samples": samples,
    })

cohorts.sort(key=lambda c: -len(c["itemIds"]))

pct = (len(weak_new) / len(match_details_new) * 100) if match_details_new else 0
print(f"  Gap detection: {len(weak_new)}/{len(match_details_new)} assigned items ({pct:.1f}%) with sim <{WEAK_SIM_MAX_NEW}")

if not cohorts:
    print(f"  No missing-collection cohorts found (passing thresholds: "
          f"cohort≥{MIN_COHORT_SIZE}, cohesion≥{MIN_COHORT_COHESION})")
else:
    print(f"  {len(cohorts)} candidate missing-collection cohort(s):")
    for c in cohorts:
        targets = ", ".join(f"{t}({n})" for t, n in c["targets"])
        print(f"\n  • {c['ollamaCategory']}: {len(c['itemIds'])} weak-match items, "
              f"cohesion {c['cohesion']:.2f}")
        print(f"      forced into → {targets}")
        for s in c["samples"]:
            print(f"      {s}")

# Extra: show what got filtered out (groups that exist as collections, too
# small, too incohesive) — diagnostic for tuning thresholds.
filtered_reasons = Counter()
for cat, ids in groups.items():
    if len(ids) < MIN_COHORT_SIZE:
        filtered_reasons["too small"] += 1
    elif cat.lower() in existing_lower:
        filtered_reasons["already a collection"] += 1
    else:
        vs = [cache[iid]["vec"] for iid in ids if iid in cache and cache[iid].get("vec")]
        if len(vs) >= 2:
            c = centroid(vs)
            if cohesion(vs, c) < MIN_COHORT_COHESION:
                filtered_reasons["low cohesion"] += 1

if filtered_reasons:
    print(f"\n  Filtered-out groups: " + ", ".join(f"{k}={v}" for k, v in filtered_reasons.most_common()))

print("\n" + "=" * 90)
print("DONE")
print("=" * 90)
