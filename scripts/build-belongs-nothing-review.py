"""Build an in-Obsidian review note for assembling the 'belongs to nothing' gold set.

Ranks the UNTOUCHED pool (no `collection` AND no `roost_category`) by ascending
cascade confidence — the items most likely to belong to no category — and renders
each inline via ![[note]] transclusion (so you preview the REAL item: title + cover
image + body in Obsidian Reading view) with a checkbox. Tick the ones that belong to
NOTHING, then run collect-belongs-nothing-gold.py.

Supersedes build-belongs-nothing-candidates.py for gold assembly: that one ranked
already-LABELED items (which belong to their label by definition); the gold OOD set
must come from the untouched pool instead.

Run: ROOST_VAULT=<vault> python scripts/build-belongs-nothing-review.py [--n 60]
"""
import os, glob, re, argparse, warnings
warnings.filterwarnings("ignore")  # sklearn/numpy matmul RuntimeWarnings on unit-norm vectors are benign noise
import numpy as np
np.seterr(all="ignore")
import honest_eval_lib as L
import rej_signals as S
import rej_negatives as N

_TITLE = re.compile(r'^title:\s*(.+)$', re.M)


def resolve_notes(vault, need_ids, sync_folder="Bookmarks"):
    """roost_id -> (vault_relative_path_without_ext, title) for the needed ids only.
    Stops scanning once all are found."""
    need = set(need_ids)
    idx = {}
    for p in glob.glob(os.path.join(vault, sync_folder, "**", "*.md"), recursive=True):
        if len(idx) == len(need):
            break
        try:
            raw = open(p, encoding="utf-8").read()
        except OSError:
            continue
        rid_m = re.search(r'^roost_id:\s*"?([^"\n]+)"?', raw, re.M)
        rid = rid_m.group(1).strip() if rid_m else None
        if rid in need and rid not in idx:
            fm_block = raw.split("---", 2)[1] if raw.startswith("---") else raw
            tm = _TITLE.search(fm_block)
            title = tm.group(1).strip().strip('"').strip("'") if tm else ""
            rel = os.path.relpath(p, vault)
            if rel.endswith(".md"):
                rel = rel[:-3]
            idx[rid] = (rel, title)
    return idx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=60, help="how many candidates to review")
    ap.add_argument("--out", default="Roost Rejection Review.md", help="review note path (vault-relative)")
    args = ap.parse_args()
    vault = os.environ["ROOST_VAULT"]

    cache = L.load_cache(bin_path=os.path.join(vault, ".roost", "cache", "embedding-vectors.bin"))
    labels, _ = L.load_honest_labels(vault)
    train = [{"id": i, "groundTruth": c, "isNegative": False}
             for i, c in labels.items() if cache.get(i) is not None]
    clf, classes = S.train_head(train, cache)
    cents = L.build_centroids(
        {c: [(it["id"], cache[it["id"]]) for it in train if it["groundTruth"] == c]
         for c in set(labels.values())}, exclude_ids=[])

    pool = N.unlabeled_pool(vault, cache, cap=10 ** 9)  # all untouched items
    scored = []
    for rid in pool:
        _, conf = S.head_conf(clf, classes, cache, rid)
        bcat, bsim = S.centroid_score(cents, cache, rid)
        scored.append((conf, bsim, rid, bcat))
    scored.sort(key=lambda t: (t[0], t[1]))  # least confident first
    top = scored[:args.n]

    idx = resolve_notes(vault, [rid for _, _, rid, _ in top])
    lines = [
        "# Roost Rejection Review — belongs-to-nothing gold set", "",
        f"> {len(top)} untouched items the cascade is LEAST confident about (most likely to belong to no category).",
        "> **Tick the box for each item that belongs to NO category.** Read in *Reading view* to see the embedded previews.",
        "> Then run: `ROOST_VAULT=<vault> python scripts/collect-belongs-nothing-gold.py`", "",
        "> Leave items that DO fit an existing category unticked. Sampling is biased toward",
        "> low-confidence items (efficient for finding OOD), so the resulting OSCR is a first",
        "> trusted estimate, not an unbiased base-rate.", "",
        "---", "",
    ]
    missing = 0
    for i, (conf, bsim, rid, bcat) in enumerate(top, 1):
        rel, title = idx.get(rid, (None, ""))
        lines.append(f"## {i}. {title or rid}")
        lines.append(f"nearest category: **{bcat}** (sim {bsim:.2f}) · head-conf {conf:.2f} · `{rid}`")
        lines.append(f"- [ ] belongs to NOTHING  <!--id: {rid}-->")
        lines.append("")
        if rel:
            lines.append(f"![[{rel}]]")
        else:
            missing += 1
            lines.append("_(note file not found for preview)_")
        lines.append("")
        lines.append("---")
        lines.append("")

    out_path = os.path.join(vault, args.out)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print(f"wrote review note: {len(top)} candidates, {missing} without preview -> {out_path}")
    print("Open it in Obsidian (Reading view), tick the 'belongs to NOTHING' boxes,")
    print("then: ROOST_VAULT=<vault> python scripts/collect-belongs-nothing-gold.py")


if __name__ == "__main__":
    main()
