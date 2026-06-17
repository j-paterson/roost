"""Build the honest eval fixture (positives = non-auto `collection`; negatives = no
collection) + a seeded, stratified dev/holdout split. Writes to <vault>/.roost/build
(gitignored). GT is NEVER roost_category. Run: ROOST_VAULT=<vault> python scripts/build-honest-fixture.py"""
import os, sys, json, random
from collections import defaultdict
import honest_eval_lib as L

def main():
    vault = os.environ.get("ROOST_VAULT") or sys.argv[1]
    build = os.path.join(vault, ".roost", "build")
    os.makedirs(build, exist_ok=True)
    cache = L.load_cache(bin_path=os.path.join(vault, ".roost", "cache", "embedding-vectors.bin"))
    labels, negatives = L.load_honest_labels(vault)
    pos = [i for i in labels if i in cache]
    neg = [i for i in negatives if i in cache]
    rng = random.Random(L.SEED)
    rng.shuffle(neg)
    neg = neg[:100]  # balanced negative pool
    items = [{"id": i, "groundTruth": labels[i], "isNegative": False} for i in pos] + \
            [{"id": i, "groundTruth": None, "isNegative": True} for i in neg]
    by = defaultdict(list)
    for it in items:
        by[it["groundTruth"]].append(it)
    dev, hold = [], []
    for _cat, ts in by.items():
        ts = ts[:]; rng.shuffle(ts)
        k = max(1, round(len(ts) * 0.30)) if len(ts) >= 2 else 0
        hold += ts[:k]; dev += ts[k:]
    def dump(split, rows):
        with open(os.path.join(build, f"eval-fixture-{split}.json"), "w") as fh:
            json.dump({"seed": L.SEED, "split": split, "testItems": rows}, fh)
    dump("large", items); dump("dev", dev); dump("holdout", hold)
    L.assert_disjoint([t["id"] for t in dev], [t["id"] for t in hold])
    print(f"large={len(items)} (pos {len(pos)}, neg {len(neg)}) | dev={len(dev)} holdout={len(hold)} | seed={L.SEED}")
    print("sample:", [(t["id"], t["groundTruth"]) for t in dev[:5]])

if __name__ == "__main__":
    main()
