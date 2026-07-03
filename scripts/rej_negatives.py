"""Negative (out-of-set) ground truth for the fresh rejection eval.
PRIMARY = leave-one-category-out (constructed OOD). TRUSTED = assisted gold set
(human-verified). DIAGNOSTIC-ONLY = the untouched unlabeled pool (NOT ground truth
— the fixture's 'isNegative' items were verified 2026-07-03 to be ~81% items that
actually belong to a category, so they are deliberately NOT used here)."""
import os, json, glob, random
import honest_eval_lib as L

def unlabeled_pool(vault, cache, cap=1000, sync_folder="Bookmarks"):
    """DIAGNOSTIC ONLY. Vault items with no `collection` AND no `roost_category`
    (truly untouched — neither human- nor system-sorted). Not verified 'belongs to
    nothing'; used only for a caveated accept-rate, never OSCR/AUROC."""
    ids = []
    for p in glob.glob(os.path.join(vault, sync_folder, "**", "*.md"), recursive=True):
        fm = L._read_fm(p)
        rid = fm.get("roost_id")
        if not rid or cache.get(rid) is None:
            continue
        if not fm.get("collection") and not fm.get("roost_category"):
            ids.append(rid)
    random.Random(L.SEED).shuffle(ids)
    return ids[:cap]

def leave_one_out(train_items, eval_items, category):
    train_wo = [it for it in train_items
                if it.get("isNegative") or it["groundTruth"] != category]
    ood_ids = [it["id"] for it in eval_items
               if not it.get("isNegative") and it["groundTruth"] == category]
    return train_wo, ood_ids

def load_gold(build_dir):
    p = os.path.join(build_dir, "belongs-nothing-gold.json")
    if not os.path.exists(p):
        return []
    return json.load(open(p)).get("ids", [])
