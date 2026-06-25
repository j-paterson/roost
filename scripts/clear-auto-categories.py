#!/usr/bin/env python3
"""Clear roost_category for auto-assigned items so a single Smart Assign run
re-scores them through the stacked path (they become "unsorted").

Scope (strict): roost_assigned_by == "auto"  AND  roost_category set  AND no
non-empty `collection` field (a collection would keep the item anchored/sorted).
roost_assigned_by is left as "auto"; only the roost_category line is removed.
The `collection` field and everything else are untouched.

Reversible: writes a backup {roost_id: {path, roost_category}} BEFORE editing.
Restore with --restore <backup.json>.

Dry-run by default. Pass --apply to write.

Run:  ROOST_VAULT=<vault> python scripts/clear-auto-categories.py [--apply]
"""
import argparse
import glob
import json
import os
import re
import sys
import time
from pathlib import Path

FM_RE = re.compile(r"^(---\r?\n)(.*?\r?\n)(---\r?\n)(.*)$", re.S)


def fm_get(fm, key):
    m = re.search(rf"^{key}:\s*(.*)$", fm, re.M)
    return m.group(1).strip().strip('"') if m else ""


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry-run)")
    ap.add_argument("--restore", metavar="BACKUP_JSON", help="restore roost_category from a backup file")
    args = ap.parse_args()

    V = os.environ.get("ROOST_VAULT")
    if not V:
        print("ERROR: ROOST_VAULT not set."); sys.exit(1)
    V = str(Path(V))
    cache_dir = os.path.join(V, ".roost", "cache")

    if args.restore:
        backup = json.load(open(args.restore))  # { relpath: {roost_category, roost_subcategory} }
        n = 0
        for relpath, info in backup.items():
            p = os.path.join(V, relpath)
            if not os.path.exists(p):
                continue
            t = open(p, encoding="utf-8", errors="ignore").read()
            m = FM_RE.match(t)
            if not m:
                continue
            head, fm, sep, body = m.groups()
            additions = ""
            if info.get("roost_category") and not re.search(r"^roost_category:", fm, re.M):
                additions += f'roost_category: {info["roost_category"]}\n'
            if info.get("roost_subcategory") and not re.search(r"^roost_subcategory:", fm, re.M):
                additions += f'roost_subcategory: {info["roost_subcategory"]}\n'
            if not additions:
                continue
            if re.search(r"^roost_assigned_by:", fm, re.M):
                fm = re.sub(r"^(roost_assigned_by:.*\r?\n)", r"\1" + additions, fm, count=1, flags=re.M)
            else:
                fm = fm + additions
            open(p, "w", encoding="utf-8").write(head + fm + sep + body)
            n += 1
        print(f"restored {n} files (category/subcategory re-inserted where backed up)")
        return

    backup = {}
    changed = skipped_coll = 0
    samples = []
    for p in glob.glob(V + "/Bookmarks/**/*.md", recursive=True):
        try:
            t = open(p, encoding="utf-8", errors="ignore").read()
        except Exception:
            continue
        m = FM_RE.match(t)
        if not m:
            continue
        head, fm, sep, body = m.groups()
        if not fm_get(fm, "roost_id"):
            continue
        # Non-human = the pipeline's own "auto" definition (buildFilterInput: anything
        # not "human" is treated as auto). Covers explicit auto AND unstamped items.
        if fm_get(fm, "roost_assigned_by") == "human":
            continue
        cat = fm_get(fm, "roost_category")
        sub = fm_get(fm, "roost_subcategory")
        cat_set = bool(cat) and cat not in ("undefined", "null")
        sub_set = bool(sub) and sub not in ("undefined", "null")
        if not cat_set and not sub_set:
            continue  # nothing to clear
        coll = fm_get(fm, "collection")
        if coll and coll not in ("undefined", "null"):
            skipped_coll += 1
            continue  # anchored by collection — clearing roost_category wouldn't unsort it
        rid = fm_get(fm, "roost_id")
        new_fm = re.sub(r"^roost_category:.*\r?\n", "", fm, flags=re.M)
        new_fm = re.sub(r"^roost_subcategory:.*\r?\n", "", new_fm, flags=re.M)
        backup[os.path.relpath(p, V)] = {
            "roost_id": rid,
            "roost_category": cat if cat_set else None,
            "roost_subcategory": sub if sub_set else None,
        }
        if len(samples) < 4:
            samples.append((rid, cat if cat_set else "-", sub if sub_set else "-"))
        changed += 1
        if args.apply:
            open(p, "w", encoding="utf-8").write(head + new_fm + sep + body)

    print(f"{'APPLIED' if args.apply else 'DRY-RUN'}: would clear roost_category on {changed} auto items")
    print(f"  skipped (auto + has collection anchor): {skipped_coll}")
    print(f"  sample (roost_id | category cleared): {samples}")

    if args.apply:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        bpath = os.path.join(cache_dir, f"recategorize-backup-clear-autos-{stamp}.json")
        json.dump(backup, open(bpath, "w"))
        print(f"  backup written: {bpath}")
        print(f"  restore with:   python scripts/clear-auto-categories.py --restore '{bpath}'")
    else:
        print("  (dry-run — no files changed, no backup written. Re-run with --apply.)")


if __name__ == "__main__":
    main()
