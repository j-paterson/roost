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
