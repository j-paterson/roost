"""Collect the ticked 'belongs to nothing' items from the review note into the gold set.

Reads the review note produced by build-belongs-nothing-review.py, finds every checked
(`- [x] belongs to NOTHING <!--id: ...-->`) box, and writes the verified out-of-set ids
to <vault>/.roost/build/belongs-nothing-gold.json (the trusted OOD set the rejection eval
reads via rej_negatives.load_gold).

Run: ROOST_VAULT=<vault> python scripts/collect-belongs-nothing-gold.py [--review "Roost Rejection Review.md"]
"""
import os, json, re, argparse

# Matches a checked box; [x] or [X]; tolerant of extra spaces.
_CHECKED = re.compile(r'-\s*\[[xX]\]\s*belongs to NOTHING\s*<!--\s*id:\s*(.+?)\s*-->')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--review", default="Roost Rejection Review.md", help="review note path (vault-relative)")
    args = ap.parse_args()
    vault = os.environ["ROOST_VAULT"]

    review_path = os.path.join(vault, args.review)
    if not os.path.exists(review_path):
        raise SystemExit(f"review note not found: {review_path} — run build-belongs-nothing-review.py first")
    with open(review_path, encoding="utf-8") as fh:
        text = fh.read()

    ids = [m.strip() for m in _CHECKED.findall(text)]
    # de-dup, preserve order
    seen, uniq = set(), []
    for i in ids:
        if i not in seen:
            seen.add(i)
            uniq.append(i)

    out = os.path.join(vault, ".roost", "build", "belongs-nothing-gold.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump({"ids": uniq}, fh, indent=2)
    print(f"collected {len(uniq)} belongs-to-nothing items -> {out}")
    if uniq:
        print("sample:", uniq[:5])
    print("Now re-run the eval to populate OSCR-vs-gold:")
    print("  ROOST_VAULT=<vault> python scripts/exp-rejection-fresh.py")


if __name__ == "__main__":
    main()
