#!/usr/bin/env python3
"""Patch the 119-item test fixture by dropping positive items whose ground-truth
collection no longer exists in the current vault.

Background: the Apr 10 fixture was sampled from vault state at that time.
Since then, three collections (Want to go, Drinks, Watchlist) have been
removed/merged, leaving 13 of 119 positive items unscorable — their GT has
zero members and no centroid, so it cannot appear in any top-K.

This script preserves the Apr 10 hand-audit signal on the remaining 106
items by trimming rather than re-sampling. A full rebuild + re-audit is
deferred until the next major taxonomy shift.

Output: strategy-results-v2.json next to the original, with:
  - positive items whose GT is missing from the vault dropped
  - testSize/positiveCount fields updated
  - drop log written to .roost/fixture-patch-log.json

Usage:
  patch-test-fixture.py [--input strategy-results.json] [--output strategy-results-v2.json]
"""
import argparse
import json
import re
from collections import Counter
from pathlib import Path

VAULT = Path.home() / "ObsidianBookmarks"
ROOST = VAULT / ".roost"


def load_vault_collections():
    """Read every bookmark's roost_category frontmatter; return dict id→category and
    the set of categories that have at least one member."""
    labels = {}
    for md in (VAULT / "Bookmarks").rglob("*.md"):
        try:
            content = md.read_text(encoding="utf-8")
        except Exception:
            continue
        if not content.startswith("---\n"):
            continue
        end = content.find("\n---", 4)
        if end < 0:
            continue
        fm = content[4:end]
        id_match = re.search(r'^roost_id:\s*"?([^"\n]+)"?', fm, re.MULTILINE)
        if not id_match:
            continue
        rid = id_match.group(1).strip()
        coll_match = re.search(r'^collection:\s*(.+)', fm, re.MULTILINE)
        cat_match = re.search(r'^roost_category:\s*(.+)', fm, re.MULTILINE)
        cat = cat_match.group(1) if cat_match else (coll_match.group(1) if coll_match else None)
        if not cat:
            continue
        cat = cat.strip().strip('"')
        if cat and cat not in ("undefined", "null"):
            labels[rid] = cat
    return labels


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="strategy-results.json")
    ap.add_argument("--output", default="strategy-results-v2.json")
    args = ap.parse_args()

    in_path = ROOST / args.input
    out_path = ROOST / args.output
    log_path = ROOST / "fixture-patch-log.json"

    print(f"Loading {in_path}")
    fixture = json.load(open(in_path))
    items = fixture["testItems"]
    n_pos_before = sum(1 for t in items if not t.get("isNegative"))
    n_neg_before = sum(1 for t in items if t.get("isNegative"))
    print(f"  Before: {n_pos_before} positive + {n_neg_before} negative = {len(items)} total")

    print("Loading vault frontmatter…")
    labels = load_vault_collections()
    present = set(labels.values())
    print(f"  Vault has {len(present)} non-empty collections, {len(labels)} labeled items")

    kept = []
    dropped = []
    for t in items:
        if t.get("isNegative"):
            kept.append(t)
            continue
        gt = t["groundTruth"]
        if gt in present:
            kept.append(t)
        else:
            dropped.append({"id": t["id"], "groundTruth": gt, "summary": t.get("summary", "")[:120]})

    n_pos_after = sum(1 for t in kept if not t.get("isNegative"))
    n_neg_after = sum(1 for t in kept if t.get("isNegative"))

    drop_counts = Counter(d["groundTruth"] for d in dropped)
    print(f"\nDropped {len(dropped)} positive items (GT no longer in vault):")
    for gt, n in drop_counts.most_common():
        print(f"  {gt}: {n}")

    print(f"\nAfter:  {n_pos_after} positive + {n_neg_after} negative = {len(kept)} total")

    new_fixture = dict(fixture)
    new_fixture["testItems"] = kept
    new_fixture["testSize"] = len(kept)
    new_fixture["positiveCount"] = n_pos_after
    new_fixture["negativeCount"] = n_neg_after
    new_fixture["patchedFrom"] = args.input
    new_fixture["patchedDroppedCount"] = len(dropped)

    json.dump(new_fixture, open(out_path, "w"), indent=2)
    print(f"\nWrote {out_path}")

    json.dump({
        "input": args.input,
        "output": args.output,
        "vaultCollections": sorted(present),
        "before": {"positive": n_pos_before, "negative": n_neg_before},
        "after": {"positive": n_pos_after, "negative": n_neg_after},
        "dropped": dropped,
    }, open(log_path, "w"), indent=2)
    print(f"Wrote drop log {log_path}")


if __name__ == "__main__":
    main()
