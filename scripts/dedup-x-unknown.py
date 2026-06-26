#!/usr/bin/env python3
"""Dedup X bookmark notes that exist twice under the same roost_id: a stale
`Unknown - <id>.md` orphan (author was unresolved at ingest; backfill fixed the
frontmatter author but not the filename) plus a live `@author - <id>.md` copy
(created by a later ingest, and the one that got categorized).

Removes the `Unknown - <id>.md` file ONLY when:
  - another file shares its roost_id (a sibling exists), AND
  - at least one sibling is NOT Unknown-named (the live @author copy), AND
  - removing it does not drop the only roost_category for that tweet (guard).

Single `Unknown - <id>.md` files with no sibling are left alone (they're the only
copy). Removed files are MOVED to a timestamped trash dir (reversible), with a
manifest — nothing is hard-deleted. Shared attachment folders (twitter-<id>/) are
never touched.

Run:  ROOST_VAULT=<vault> python scripts/dedup-x-unknown.py [--apply]
"""
import argparse, glob, json, os, re, shutil, sys, time
from collections import defaultdict

UNKNOWN_PREFIX = "Unknown - "

def fmget(t, k):
    fm = t.split("---")[1] if t.count("---") >= 2 else ""
    m = re.search(rf'^{k}:\s*"?([^"\n]*)', fm, re.M)
    return m.group(1).strip() if m else ""

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="move orphans to trash (default: dry-run)")
    args = ap.parse_args()
    V = os.environ.get("ROOST_VAULT")
    if not V: print("ERROR: ROOST_VAULT not set"); sys.exit(1)
    X = os.path.join(V, "Bookmarks", "X")

    byid = defaultdict(list)
    for p in sorted(glob.glob(X + "/*.md")):
        t = open(p, encoding="utf-8", errors="ignore").read()
        rid = fmget(t, "roost_id")
        if not rid: continue
        name = os.path.basename(p)
        byid[rid].append({
            "path": p, "name": name,
            "unknown": name.startswith(UNKNOWN_PREFIX),
            "cat": fmget(t, "roost_category"),
            "ctime": os.path.getctime(p),
        })

    # ── Confirm the theory ──────────────────────────────────────────────────
    dup_groups = {rid: fs for rid, fs in byid.items() if len(fs) > 1}
    unknown_total = sum(1 for fs in byid.values() for f in fs if f["unknown"])
    unknown_with_sibling = 0
    keeper_made_today = 0
    today = time.strftime("%Y-%m-%d")
    to_remove, guarded = [], []
    for rid, fs in dup_groups.items():
        unknowns = [f for f in fs if f["unknown"]]
        keepers = [f for f in fs if not f["unknown"]]
        if not unknowns or not keepers:
            continue
        keeper_has_cat = any(k["cat"] for k in keepers)
        # confirm-theory stat: keeper created today?
        for k in keepers:
            if time.strftime("%Y-%m-%d", time.localtime(k["ctime"])) == today:
                keeper_made_today += 1
                break
        for u in unknowns:
            unknown_with_sibling += 1
            # guard: don't delete the only categorized copy
            if u["cat"] and not keeper_has_cat:
                guarded.append(u); continue
            to_remove.append((rid, u))

    print("── Theory confirmation ──")
    print(f"X notes with duplicate roost_id (>1 file): {len(dup_groups)} ids")
    print(f"Unknown-named files total: {unknown_total}   with a same-id sibling: {unknown_with_sibling}")
    print(f"duplicate groups whose KEEPER (@author copy) was created TODAY ({today}): {keeper_made_today}")
    print(f"guarded (Unknown holds the ONLY category — NOT removing, review): {len(guarded)}")
    for g in guarded[:5]: print(f"    GUARD {g['name']}  cat={g['cat']}")
    print()
    print(f"── {'APPLY' if args.apply else 'DRY-RUN'}: would move {len(to_remove)} orphan files to trash ──")
    for rid, u in to_remove[:6]:
        print(f"    remove {u['name']}  (sibling keeps roost_id {rid})")

    if not args.apply:
        print("\n(dry-run — nothing moved. Re-run with --apply.)")
        return

    stamp = time.strftime("%Y%m%d-%H%M%S")
    trash = os.path.join(V, ".roost", "cache", f"x-dedup-trash-{stamp}")
    os.makedirs(trash, exist_ok=True)
    manifest = {}
    for rid, u in to_remove:
        dest = os.path.join(trash, u["name"])
        shutil.move(u["path"], dest)
        manifest[os.path.relpath(u["path"], V)] = {"trash": os.path.relpath(dest, V), "roost_id": rid}
    json.dump(manifest, open(os.path.join(trash, "manifest.json"), "w"), indent=2)
    print(f"\nMoved {len(to_remove)} orphan files to {trash}")
    print(f"Manifest: {os.path.join(trash, 'manifest.json')}")
    print("Reverse with: move files back from the trash dir (paths recorded in manifest.json).")

if __name__ == "__main__":
    main()
