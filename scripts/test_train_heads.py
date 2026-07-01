import struct, json, os, tempfile, importlib.util, numpy as np

spec = importlib.util.spec_from_file_location("sidecar", os.path.join(os.path.dirname(__file__), "embed-sidecar.py"))
sidecar = importlib.util.module_from_spec(spec)
# guard: importing the sidecar must not start the server (it only starts under __main__)
spec.loader.exec_module(sidecar)

def _write_bin(path, keys, mat):
    with open(path, "wb") as f:
        f.write(json.dumps(keys).encode("utf-8") + b"\n")
        f.write(mat.astype("<f4").tobytes())

def test_load_vec_bin_salvage_prefix(tmp_path):
    keys = ["a", "b", "c"]
    mat = np.arange(3 * 768, dtype="<f4").reshape(3, 768)
    p = str(tmp_path / "v.bin")
    _write_bin(p, keys, mat)
    gk, gm = sidecar.load_vec_bin(p)
    assert gk == keys
    assert gm.shape == (3, 768)
    assert np.allclose(gm[1], mat[1])

def test_train_heads_shapes():
    rng = np.random.default_rng(0)
    # 3 classes, separable-ish
    y = ["a"] * 20 + ["b"] * 20 + ["c"] * 20
    def block(off):
        return np.vstack([rng.normal(off, 0.3, (20, 768)),
                          rng.normal(off + 3, 0.3, (20, 768)),
                          rng.normal(off + 6, 0.3, (20, 768))]).astype("f4")
    heads = sidecar.train_heads(block(0.0), block(1.0), y, 3)
    for h in ("text", "vision"):
        assert heads[h]["classes"] == ["a", "b", "c"]
        assert len(heads[h]["W"]) == 3 and len(heads[h]["W"][0]) == 768
        assert len(heads[h]["b"]) == 3
        assert heads[h]["dim"] == 768 and heads[h]["norm"] == "l2" and heads[h]["version"] == 1
    assert heads["meta"]["inDim"] == 6 and heads["meta"]["norm"] == "none"
    assert len(heads["meta"]["W"]) == 3 and len(heads["meta"]["W"][0]) == 6

def test_train_heads_binary_expands_to_two_rows():
    rng = np.random.default_rng(1)
    y = ["a"] * 25 + ["b"] * 25
    X = np.vstack([rng.normal(0, 0.3, (25, 768)), rng.normal(3, 0.3, (25, 768))]).astype("f4")
    heads = sidecar.train_heads(X, X, y, 3)
    assert len(heads["text"]["W"]) == 2  # binary MUST emit K=2 rows for softmax inference
