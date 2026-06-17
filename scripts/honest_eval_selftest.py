"""Assertion-based self-tests for honest_eval_lib. Run: python scripts/honest_eval_selftest.py"""
import os, sys, json, tempfile
import numpy as np
import honest_eval_lib as L

def test_load_cache_bin_roundtrip():
    keys = ["a", "b", "c"]; dim = 4
    vecs = np.arange(len(keys) * dim, dtype=np.float32).reshape(len(keys), dim)
    d = tempfile.mkdtemp()
    binp = os.path.join(d, "v.bin")
    with open(binp, "wb") as f:
        f.write((json.dumps(keys) + "\n").encode("utf-8")); f.write(vecs.tobytes())
    json.dump({"dim": dim}, open(os.path.join(d, "embedding-meta.json"), "w"))
    cache = L.load_cache(json_path=None, bin_path=binp)
    assert set(cache) == set(keys), cache.keys()
    assert np.allclose(cache["b"], vecs[1]), cache["b"]

def test_load_cache_inline_json():
    d = tempfile.mkdtemp(); jp = os.path.join(d, "c.json")
    json.dump({"x": {"vec": [1.0, 2.0, 3.0]}, "y": {"vec": None}}, open(jp, "w"))
    cache = L.load_cache(json_path=jp, bin_path=None)
    assert "x" in cache and "y" not in cache, cache.keys()

def test_oscr_perfect_separation():
    knowns = [(True, 0.9), (True, 0.8), (True, 0.95)]
    unknowns = [0.1, 0.2, 0.05]
    assert abs(L.oscr(knowns, unknowns) - 1.0) < 1e-9, L.oscr(knowns, unknowns)

def test_oscr_penalizes_wrong_and_overlap():
    knowns = [(True, 0.9), (False, 0.85), (True, 0.4)]
    unknowns = [0.5, 0.6]
    v = L.oscr(knowns, unknowns)
    assert 0.0 <= v < 1.0, v

def test_aurc_perfect_is_low():
    items = [(0, 0.9), (0, 0.8), (1, 0.2), (1, 0.1)]  # (loss, score)
    aurc, curve = L.risk_coverage(items)
    assert len(curve) == 4
    bad, _ = L.risk_coverage([(1, 0.9), (1, 0.8), (0, 0.2), (0, 0.1)])
    assert aurc < bad, (aurc, bad)

def test_aurc_all_correct_is_zero():
    aurc, _ = L.risk_coverage([(0, 0.5), (0, 0.9)])
    assert abs(aurc) < 1e-9, aurc

def test_guard_gt_source():
    L.assert_gt_not_roost_category("frontmatter.collection")
    try:
        L.assert_gt_not_roost_category("frontmatter.roost_category"); assert False, "should raise"
    except AssertionError:
        pass

def test_guard_fixture_leak():
    L.assert_no_fixture_leak(["a", "b"], {"c", "d"})
    try:
        L.assert_no_fixture_leak(["a", "x"], {"x"}); assert False, "should raise"
    except AssertionError:
        pass

def test_guard_disjoint():
    L.assert_disjoint(["a", "b"], ["c"])
    try:
        L.assert_disjoint(["a", "b"], ["b"]); assert False, "should raise"
    except AssertionError:
        pass

def test_build_centroids_excludes_fixture():
    members = {"Cooking": [("a", np.array([1.0, 0.0])), ("b", np.array([3.0, 0.0])),
                            ("fix1", np.array([100.0, 0.0]))]}
    cents = L.build_centroids(members, exclude_ids={"fix1"})
    assert np.allclose(cents["Cooking"], [2.0, 0.0]), cents["Cooking"]

def test_build_centroids_drops_empty():
    members = {"Empty": [("fix", np.array([1.0]))]}
    cents = L.build_centroids(members, exclude_ids={"fix"})
    assert "Empty" not in cents, cents

def test_operating_point_bounds():
    knowns = [(True, 0.9), (True, 0.8), (False, 0.7)]; unknowns = [0.6, 0.5]
    accept_all = L.operating_point(knowns, unknowns, tau=-1.0, r=0.3, lam=0.0)
    assert abs(accept_all - 0.7 * (2/3)) < 1e-9, accept_all
    reject_all = L.operating_point(knowns, unknowns, tau=2.0, r=0.3, lam=0.0)
    assert abs(reject_all - 0.3) < 1e-9, reject_all

TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_")]

def main():
    fails = 0
    for t in TESTS:
        try:
            t(); print(f"PASS {t.__name__}")
        except Exception as e:
            fails += 1; print(f"FAIL {t.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(TESTS)-fails}/{len(TESTS)} passed")
    sys.exit(1 if fails else 0)

if __name__ == "__main__":
    main()
