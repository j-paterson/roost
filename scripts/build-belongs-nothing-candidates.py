"""Rank the best 'belongs to nothing' review candidates: items the current cascade
is least confident on (lowest head-conf / farthest from every centroid). Writes a
ranked JSON for a fast human yes/no pass. Run: ROOST_VAULT=<vault> python scripts/build-belongs-nothing-candidates.py [--n 100]"""
import os, json, glob, argparse
import honest_eval_lib as L
import rej_signals as S

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=100)
    args = ap.parse_args()
    vault = os.environ["ROOST_VAULT"]
    build = os.path.join(vault, ".roost", "build")
    cache = L.load_cache(bin_path=os.path.join(vault, ".roost", "cache", "embedding-vectors.bin"))
    labels, _ = L.load_honest_labels(vault)
    items = [{"id": i, "groundTruth": c, "isNegative": False} for i, c in labels.items() if cache.get(i) is not None]
    clf, classes = S.train_head(items, cache)
    cents = L.build_centroids(
        {c: [(it["id"], cache[it["id"]]) for it in items if it["groundTruth"] == c]
         for c in set(labels.values())}, exclude_ids=[])
    rows = []
    for rid in labels:
        if cache.get(rid) is None:
            continue
        pred, conf = S.head_conf(clf, classes, cache, rid)
        bcat, bsim = S.centroid_score(cents, cache, rid)
        rows.append({"id": rid, "head_conf": round(conf, 4), "best_cat": bcat,
                     "best_sim": round(bsim, 4), "cur_label": labels[rid]})
    rows.sort(key=lambda r: (r["head_conf"], r["best_sim"]))
    out = rows[:args.n]
    op = os.path.join(build, "belongs-nothing-candidates.json")
    json.dump({"candidates": out}, open(op, "w"), indent=2)
    print(f"wrote {len(out)} candidates → {op}")
    print("Review: for each, confirm it belongs to NO category, then copy its id into")
    print(f"  {os.path.join(build, 'belongs-nothing-gold.json')}  as  {{\"ids\": [...]}}")

if __name__ == "__main__":
    main()
