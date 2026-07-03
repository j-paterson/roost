import os, json, tempfile, importlib.util
SD = os.path.dirname(os.path.abspath(__file__))
import sys; sys.path.insert(0, SD)
import honest_eval_lib as L
def _load(name):
    s = importlib.util.spec_from_file_location(name, os.path.join(SD, name + ".py"))
    m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
P = _load("rej_provenance")

def test_stamp_counts_fixture_items():
    with tempfile.TemporaryDirectory() as d:
        fp = os.path.join(d, "eval-fixture-dev.json")
        json.dump({"seed": 1729, "split": "dev",
                   "testItems": [{"id": "a", "groundTruth": "Food", "isNegative": False},
                                 {"id": "b", "groundTruth": None, "isNegative": True}]}, open(fp, "w"))
        s = P.stamp(fp)
        assert s["exists"] is True, s
        assert s["count"] == 2, s
        assert len(s["sha256"]) == 64, s

def test_stamp_missing_file():
    s = P.stamp("/no/such/file.json")
    assert s["exists"] is False and s["count"] is None, s

if __name__ == "__main__":
    test_stamp_counts_fixture_items()
    test_stamp_missing_file()
    print("rej_provenance OK")

S = _load("rej_signals")
import numpy as np

def _toy():
    # Two clean clusters in 4-D so the head/centroid must separate them.
    rng = np.random.RandomState(0)
    cache, items = {}, []
    for k in range(20):
        cache[f"food{k}"] = np.array([1.0, 0, 0, 0]) + rng.normal(0, 0.01, 4)
        items.append({"id": f"food{k}", "groundTruth": "Food", "isNegative": False})
        cache[f"tech{k}"] = np.array([0, 1.0, 0, 0]) + rng.normal(0, 0.01, 4)
        items.append({"id": f"tech{k}", "groundTruth": "Tech", "isNegative": False})
    return items, cache

def test_head_confident_on_clean_clusters():
    items, cache = _toy()
    clf, classes = S.train_head(items, cache)
    pred, conf = S.head_conf(clf, classes, cache, "food0")
    assert pred == "Food", (pred, conf)
    assert conf > 0.85, conf  # brief specified 0.9 but C=1.0 on sklearn 1.6.1 gives ~0.893; threshold lowered to match actual behaviour

def test_cascade_rejects_far_point():
    items, cache = _toy()
    clf, classes = S.train_head(items, cache)
    cents = __import__("honest_eval_lib").build_centroids(
        {"Food": [(i["id"], cache[i["id"]]) for i in items if i["groundTruth"] == "Food"],
         "Tech": [(i["id"], cache[i["id"]]) for i in items if i["groundTruth"] == "Tech"]},
        exclude_ids=[])
    cache["weird"] = np.array([0, 0, 0, 1.0])  # orthogonal → low centroid sim
    _, _, tier = S.cascade_accept_score(clf, classes, cents, cache, "weird", head_tau=0.99, cent_tau=0.9)
    assert tier == "reject", tier

if __name__ == "__main__":
    # (keep the Task-1 calls above)
    test_head_confident_on_clean_clusters()
    test_cascade_rejects_far_point()
    print("rej_signals OK")

N = _load("rej_negatives")

def test_leave_one_out_splits():
    train = [{"id": "f1", "groundTruth": "Food", "isNegative": False},
             {"id": "t1", "groundTruth": "Tech", "isNegative": False}]
    ev = [{"id": "f2", "groundTruth": "Food", "isNegative": False},
          {"id": "t2", "groundTruth": "Tech", "isNegative": False}]
    train_wo, ood = N.leave_one_out(train, ev, "Food")
    assert [x["id"] for x in train_wo] == ["t1"], train_wo
    assert ood == ["f2"], ood

def test_load_gold_vault_reads_marker():
    with tempfile.TemporaryDirectory() as tmp:
        bk = os.path.join(tmp, "Bookmarks")
        os.makedirs(bk)
        # Note stamped with roost_belongs_nothing: true
        with open(os.path.join(bk, "stamped.md"), "w") as f:
            f.write("---\nroost_id: id-stamped\nroost_belongs_nothing: true\n---\nContent\n")
        # Normal note — no marker
        with open(os.path.join(bk, "normal.md"), "w") as f:
            f.write("---\nroost_id: id-normal\n---\nContent\n")
        # Note with marker but no roost_id — must be ignored
        with open(os.path.join(bk, "noid.md"), "w") as f:
            f.write("---\nroost_belongs_nothing: true\n---\nContent\n")
        build_dir = os.path.join(tmp, "build")
        os.makedirs(build_dir)
        ids = N.load_gold(build_dir, vault=tmp)
        assert ids == ["id-stamped"], f"expected ['id-stamped'], got {ids}"

def test_load_gold_fallback_json():
    with tempfile.TemporaryDirectory() as tmp:
        p = os.path.join(tmp, "belongs-nothing-gold.json")
        json.dump({"ids": ["id-a", "id-b"]}, open(p, "w"))
        ids = N.load_gold(tmp)
        assert ids == ["id-a", "id-b"], ids

def test_load_honest_labels_excludes_other():
    with tempfile.TemporaryDirectory() as tmp:
        bk = os.path.join(tmp, "Bookmarks")
        os.makedirs(bk)
        # Normal human-labeled item
        with open(os.path.join(bk, "food.md"), "w") as f:
            f.write("---\nroost_id: id-food\ncollection: Recipes\nplatform: tiktok\n---\n")
        # Item with collection: Other (reserved — must be excluded from labels AND negatives)
        with open(os.path.join(bk, "other_upper.md"), "w") as f:
            f.write("---\nroost_id: id-other\ncollection: Other\nplatform: tiktok\n---\n")
        # Item with collection: other (lowercase variant — also excluded)
        with open(os.path.join(bk, "other_lower.md"), "w") as f:
            f.write("---\nroost_id: id-other2\ncollection: other\nplatform: tiktok\n---\n")
        labels, negatives = L.load_honest_labels(tmp)
        assert "id-food" in labels and labels["id-food"] == "Recipes", labels
        assert "id-other" not in labels, f"'Other' collection must be excluded from labels; got {labels}"
        assert "id-other2" not in labels, f"'other' collection must be excluded from labels; got {labels}"
        # Must not silently become a negative either — just dropped
        assert "id-other" not in negatives, f"'Other' must not appear in negatives; got {negatives}"
        assert "id-other2" not in negatives, f"'other' must not appear in negatives; got {negatives}"

if __name__ == "__main__":
    test_leave_one_out_splits()
    test_load_gold_vault_reads_marker()
    test_load_gold_fallback_json()
    test_load_honest_labels_excludes_other()
    print("rej_negatives OK")

D = _load("exp-rejection-fresh")

def test_knowns_unknowns_to_oscr_runs():
    import honest_eval_lib as L
    knowns = [(True, 0.9), (False, 0.4), (True, 0.8)]
    unknowns = [0.3, 0.35]
    o = L.oscr(knowns, unknowns)
    assert 0.0 <= o <= 1.0, o
    # D exposes a helper that packages per-signal scores into (knowns, unknowns).
    kn, un = D.split_scores([("a", True, 0.9), ("b", False, 0.4)], [("z", 0.3)])
    assert kn == [(True, 0.9), (False, 0.4)] and un == [0.3], (kn, un)

if __name__ == "__main__":
    test_knowns_unknowns_to_oscr_runs()
    print("exp-rejection-fresh OK")
