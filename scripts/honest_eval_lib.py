"""Honest, contamination-safe Smart Assign eval — shared lib.
GT is ALWAYS human `collection` (non-auto), NEVER roost_category. All eval (fixture)
items must be excluded from every model artifact (centroids AND covariance)."""
import os, json
import numpy as np

SEED = 1729  # fixed; recorded in fixtures

def load_cache(json_path=None, bin_path=None):
    """Return {id: np.ndarray(float32)}. Supports the v2 `embedding-vectors.bin`
    (keys-header + float32 matrix, dim from sibling embedding-meta.json) AND inline
    `{id: {vec: [...]}}` JSON caches (e.g. a fine-tuned cache)."""
    cache = {}
    if bin_path and os.path.exists(bin_path):
        meta_path = os.path.join(os.path.dirname(bin_path), "embedding-meta.json")
        if not os.path.exists(meta_path):
            raise FileNotFoundError(f"embedding-meta.json not found alongside {bin_path}")
        with open(meta_path) as mf:
            dim = int(json.load(mf)["dim"])
        with open(bin_path, "rb") as bf:
            raw = bf.read()
        nl = raw.index(b"\n")
        keys = json.loads(raw[:nl].decode("utf-8"))
        start = nl + 1
        ab = raw[start:start + len(keys) * dim * 4]  # copy → 4-byte aligned
        floats = np.frombuffer(ab, dtype=np.float32).reshape(len(keys), dim)
        for i, k in enumerate(keys):
            cache[k] = floats[i]
    if json_path and os.path.exists(json_path):
        with open(json_path) as jf:
            entries = json.load(jf)
        for k, v in entries.items():
            if isinstance(v, dict) and v.get("vec") is not None:
                cache.setdefault(k, np.asarray(v["vec"], dtype=np.float32))
    return cache


# ── Metrics ──────────────────────────────────────────────────────────────────

def oscr(knowns, unknowns):
    """Open-Set Classification Rate = area under the CCR-vs-FPR curve (∈[0,1], higher
    better). knowns: list[(correct: bool, score: float)] (score = accept-confidence,
    higher = more in-set). unknowns: list[float] scores. Accept iff score >= θ;
    CCR(θ)=correct&accepted knowns / |knowns|; FPR(θ)=accepted unknowns / |unknowns|.
    Dhamija et al., NeurIPS 2018."""
    K, U = len(knowns), len(unknowns)
    if K == 0 or U == 0:
        raise ValueError("oscr needs both knowns and unknowns")
    thetas = sorted(set([s for _, s in knowns] + list(unknowns)), reverse=True)
    pts = [(0.0, 0.0)]  # θ=+inf accepts nothing
    for th in thetas:
        ccr = sum(1 for c, s in knowns if c and s >= th) / K
        fpr = sum(1 for s in unknowns if s >= th) / U
        pts.append((fpr, ccr))
    pts.sort()
    area = 0.0
    for i in range(1, len(pts)):
        (x0, y0), (x1, y1) = pts[i - 1], pts[i]
        area += (x1 - x0) * (y0 + y1) / 2.0
    return area


def risk_coverage(items):
    """Selective-classification AURC. items: list[(loss: 0|1, score: float)] where
    loss=1 means accepting this item is an error (known-misclassified OR unknown
    accepted). Accept highest-score first; risk = mean loss over accepted, coverage =
    fraction accepted. Returns (aurc ∈[0,1] lower-better, curve=[(coverage, risk)])."""
    n = len(items)
    if n == 0:
        raise ValueError("risk_coverage needs items")
    order = sorted(items, key=lambda t: -t[1])
    cum = 0.0
    curve = []
    for i, (loss, _s) in enumerate(order, 1):
        cum += loss
        curve.append((i / n, cum / i))
    area = 0.0
    pc, pr = 0.0, 0.0
    for cov, risk in curve:
        area += (cov - pc) * (risk + pr) / 2.0
        pc, pr = cov, risk
    return area, curve


def operating_point(knowns, unknowns, tau, r, lam):
    """Secondary 'deployment view' (NOT the headline). Base-rate-weighted correct-
    action utility at a single accept threshold tau. Accept iff score >= tau.
    knowns:[(correct,score)] → +1 right&accepted, -lam wrong&accepted, 0 rejected.
    unknowns:[score] → +1 rejected, -lam accepted. r = out-of-set base rate; lam =
    mis-filing cost vs leaving unsorted. λ/r are deployment choices, not eval params."""
    K, U = len(knowns), len(unknowns)
    pos = sum((1.0 if c else -lam) if s >= tau else 0.0 for c, s in knowns) / K
    neg = sum((-lam) if s >= tau else 1.0 for s in unknowns) / U
    return (1.0 - r) * pos + r * neg


# ── Centroids ────────────────────────────────────────────────────────────────

def build_centroids(members, exclude_ids):
    """Plain-mean centroids with exclude_ids (the full fixture) removed from members.
    Production-faithful centroids come from export-honest-centroids.ts instead; this
    is the simple in-Python option for ablations. Callers MUST pass the full fixture
    as exclude_ids and run assert_no_fixture_leak."""
    exclude = set(exclude_ids)
    cents = {}
    for coll, items in members.items():
        kept = [v for i, v in items if i not in exclude]
        if kept:
            cents[coll] = np.mean(kept, axis=0)
    return cents


# ── Contamination guards ─────────────────────────────────────────────────────

def assert_gt_not_roost_category(source):
    """Ground truth must come from the human `collection` field, never the system's
    own `roost_category` (that contamination produced the historical false results)."""
    if "roost_category" in source:
        raise AssertionError(f"GT source '{source}' references roost_category — use `collection` only")


def assert_no_fixture_leak(member_ids, fixture_ids):
    """No eval (fixture) item may appear in any model artifact — centroid members OR
    covariance inputs. A covariance that included held-out items previously flipped a result."""
    leak = set(member_ids) & set(fixture_ids)
    if leak:
        raise AssertionError(f"{len(leak)} fixture ids leaked into model members (e.g. {list(leak)[:3]})")


def assert_disjoint(dev_ids, holdout_ids):
    overlap = set(dev_ids) & set(holdout_ids)
    if overlap:
        raise AssertionError(f"dev/holdout overlap: {len(overlap)} ids")


# ── Vault loaders ─────────────────────────────────────────────────────────────

import glob, re

_FM = re.compile(r"^---\n(.*?)\n---", re.S)
_FIELD = re.compile(r"^(roost_id|collection|roost_category|roost_assigned_by|platform):\s*(.+)$")


def _read_fm(path):
    with open(path, encoding="utf-8") as fh:
        content = fh.read()
    m = _FM.match(content)
    if not m:
        return {}
    out = {}
    for line in m.group(1).split("\n"):
        f = _FIELD.match(line)
        if f:
            out[f.group(1)] = f.group(2).strip().strip('"').strip("'")
    return out


def load_collection_aliases(vault):
    """Read .roost/cache/collection-aliases.json ({"platform:collection": category}).
    Returns {} when the file is absent."""
    path = os.path.join(vault, ".roost", "cache", "collection-aliases.json")
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def apply_alias(aliases, platform, collection):
    """Resolve a source collection to its canonical category via the alias map,
    falling back to the raw collection name. Mirrors TS makeAliasKey('platform:name')."""
    return aliases.get(f"{platform}:{collection}", collection)


def load_honest_labels(vault, sync_folder="Bookmarks"):
    """{roost_id: category} for items whose roost_assigned_by != 'auto'. The collection
    is resolved through the alias map (.roost/cache/collection-aliases.json) so that
    renamed collections map to their canonical category; falls back to the raw collection
    when no alias exists. GT is the human `collection` field ONLY — never roost_category.
    Also returns the set of negative ids (have roost_id but no collection)."""
    assert_gt_not_roost_category("collection")  # tripwire: this loader uses `collection`
    aliases = load_collection_aliases(vault)
    labels, negatives = {}, set()
    for p in glob.glob(os.path.join(vault, sync_folder, "**", "*.md"), recursive=True):
        fm = _read_fm(p)
        rid = fm.get("roost_id")
        if not rid:
            continue
        coll = fm.get("collection")
        if coll and fm.get("roost_assigned_by") != "auto" and coll not in ("undefined", "null", ""):
            labels[rid] = apply_alias(aliases, fm.get("platform", ""), coll)
        elif not coll:
            negatives.add(rid)
    return labels, negatives


def load_fixture(build_dir, split):
    """split ∈ {large, dev, holdout}. Returns the testItems list; each item is
    {id, groundTruth, isNegative} (groundTruth is None for negatives)."""
    with open(os.path.join(build_dir, f"eval-fixture-{split}.json")) as fh:
        f = json.load(fh)
    return f["testItems"]
