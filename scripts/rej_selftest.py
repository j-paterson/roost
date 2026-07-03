import os, json, tempfile, importlib.util
SD = os.path.dirname(os.path.abspath(__file__))
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
