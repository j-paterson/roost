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
        backup = json.load(open(args.restore))
        # Build roost_id -> [all current file paths] so duplicate-id files (e.g. the
        # "@author"/"Unknown" Twitter pairs) all get restored, not just the one path
        # captured in the backup.
        id_to_paths = {}
        for p in glob.glob(str(Path(os.environ["ROOST_VAULT"])) + "/Bookmarks/**/*.md", recursive=True):
            try:
                fm = open(p, encoding="utf-8", errors="ignore").read().split("---")
            except Exception:
                continue
            block = fm[1] if len(fm) >= 3 else ""
            mid = re.search(r'^roost_id:\s*"?([^"\n]+)', block, re.M)
            if mid:
                id_to_paths.setdefault(mid.group(1).strip(), []).append(p)
        n = 0
        for rid, info in backup.items():
            for p in id_to_paths.get(rid, [os.path.join(V, info["path"])]):
                if not os.path.exists(p):
                    continue
                t = open(p, encoding="utf-8", errors="ignore").read()
                m = FM_RE.match(t)
                if not m:
                    continue
                head, fm, sep, body = m.groups()
                if re.search(r"^roost_category:", fm, re.M):
                    continue  # already has one; don't double-write
                line = f'roost_category: {info["roost_category"]}\n'
                if re.search(r"^roost_assigned_by:", fm, re.M):
                    fm = re.sub(r"^(roost_assigned_by:.*\r?\n)", r"\1" + line, fm, count=1, flags=re.M)
                else:
                    fm = fm + line
                open(p, "w", encoding="utf-8").write(head + fm + sep + body)
                n += 1
        print(f"restored roost_category on {n} files")
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
        if fm_get(fm, "roost_assigned_by") != "auto":
            continue
        cat = fm_get(fm, "roost_category")
        if not cat or cat in ("undefined", "null"):
            continue
        coll = fm_get(fm, "collection")
        if coll and coll not in ("undefined", "null"):
            skipped_coll += 1
            continue  # anchored by collection — clearing roost_category wouldn't unsort it
        rid = fm_get(fm, "roost_id")
        new_fm = re.sub(r"^roost_category:.*\r?\n", "", fm, flags=re.M)
        backup[rid] = {"path": os.path.relpath(p, V), "roost_category": cat}
        if len(samples) < 4:
            samples.append((rid, cat))
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
