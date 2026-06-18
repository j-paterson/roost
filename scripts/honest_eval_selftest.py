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

def test_apply_alias_resolves_and_falls_back():
    aliases = {"twitter:Cooking ideas": "Recipes"}
    # mapped
    assert L.apply_alias(aliases, "twitter", "Cooking ideas") == "Recipes"
    # no entry -> falls back to the raw collection
    assert L.apply_alias(aliases, "tiktok", "Recipes") == "Recipes"
    # empty map -> raw collection
    assert L.apply_alias({}, "twitter", "Cooking ideas") == "Cooking ideas"

def test_auroc_perfect_separation():
    """When knowns score higher than unknowns, AUROC should be ≈1.0."""
    knowns = [(True, 0.9), (False, 0.85), (True, 0.8)]
    unknowns = [0.1, 0.2, 0.15]
    v = L.auroc(knowns, unknowns)
    assert abs(v - 1.0) < 1e-9, f"expected ≈1.0 for perfect separation, got {v}"

def test_auroc_inseparable():
    """When knowns and unknowns have identical scores, AUROC should be ≈0.5."""
    # Interleaved identical scores → random performance
    knowns = [(True, 0.5), (True, 0.5), (True, 0.5)]
    unknowns = [0.5, 0.5, 0.5]
    v = L.auroc(knowns, unknowns)
    assert abs(v - 0.5) < 0.05, f"expected ≈0.5 for inseparable inputs, got {v}"

def test_auroc_reversed():
    """When unknowns score higher than knowns, AUROC should be ≈0.0."""
    knowns = [(True, 0.1), (True, 0.2), (True, 0.15)]
    unknowns = [0.9, 0.8, 0.85]
    v = L.auroc(knowns, unknowns)
    assert v < 0.05, f"expected ≈0.0 for fully reversed scores, got {v}"

def test_auroc_needs_both_sides():
    try:
        L.auroc([], [0.5]); assert False, "should raise"
    except ValueError:
        pass
    try:
        L.auroc([(True, 0.5)], []); assert False, "should raise"
    except ValueError:
        pass

def test_aupr_perfect_separation():
    """When knowns score strictly above unknowns, AUPR should be ≈1.0."""
    knowns = [(True, 0.9), (True, 0.85), (True, 0.8)]
    unknowns = [0.1, 0.2, 0.15]
    v = L.aupr(knowns, unknowns)
    assert abs(v - 1.0) < 1e-9, f"expected ≈1.0 for perfect separation, got {v}"

def test_aupr_inseparable():
    """When all scores are equal, AUPR is bounded above by K/(K+U) (pessimistic tie-breaking
    places all OOD items before knowns at the same threshold, depressing early precision).
    Assert it is strictly below 1.0 and below the perfect-separation score."""
    K, U = 3, 3
    knowns_tied = [(True, 0.5)] * K
    unknowns_tied = [0.5] * U
    tied_aupr = L.aupr(knowns_tied, unknowns_tied)
    # Inseparable must be strictly worse than perfect separation
    perfect_knowns = [(True, 0.9 - i * 0.1) for i in range(K)]
    perfect_unknowns = [0.1 + i * 0.01 for i in range(U)]
    perfect_aupr = L.aupr(perfect_knowns, perfect_unknowns)
    assert tied_aupr < perfect_aupr, (
        f"inseparable AUPR {tied_aupr:.4f} should be < perfect AUPR {perfect_aupr:.4f}"
    )
    # Must be in [0, 1]
    assert 0.0 <= tied_aupr <= 1.0, f"AUPR out of range: {tied_aupr}"

def test_aupr_better_than_inseparable_when_separated():
    """A separated classifier must score strictly above the random baseline."""
    K, U = 5, 5
    knowns = [(True, 0.9 - i * 0.01) for i in range(K)]
    unknowns = [0.1 + i * 0.01 for i in range(U)]
    good = L.aupr(knowns, unknowns)
    bad_knowns = [(True, 0.1 + i * 0.01) for i in range(K)]
    bad_unknowns = [0.9 - i * 0.01 for i in range(U)]
    bad = L.aupr(bad_knowns, bad_unknowns)
    assert good > bad, f"separated AUPR {good} should exceed reversed AUPR {bad}"

def test_aupr_needs_both_sides():
    try:
        L.aupr([], [0.5]); assert False, "should raise"
    except ValueError:
        pass
    try:
        L.aupr([(True, 0.5)], []); assert False, "should raise"
    except ValueError:
        pass

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
