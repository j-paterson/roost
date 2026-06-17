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
