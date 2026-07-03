"""Reject-signal library for the fresh rejection eval. Held-out by construction:
train on the TRAIN split, score the held-out split. Signals: production cascade
(head-conf -> centroid), head confidence alone, centroid cosine, RelMahalanobis."""
import numpy as np
from sklearn.linear_model import LogisticRegression

def _l2(v):
    v = np.asarray(v, dtype=np.float64)
    n = np.linalg.norm(v)
    return v / n if n else v

def train_head(train_items, cache):
    rows = [(it["id"], it["groundTruth"]) for it in train_items
            if not it.get("isNegative") and it["groundTruth"] and cache.get(it["id"]) is not None]
    X = np.array([_l2(cache[i]) for i, _ in rows])
    y = [c for _, c in rows]
    clf = LogisticRegression(max_iter=1500, C=1.0, class_weight="balanced")
    clf.fit(X, y)
    return clf, list(clf.classes_)

def head_conf(clf, classes, cache, rid):
    v = cache.get(rid)
    if v is None:
        return None, 0.0
    p = clf.predict_proba(_l2(v).reshape(1, -1))[0]
    j = int(np.argmax(p))
    return classes[j], float(p[j])

def centroid_score(cents, cache, rid):
    v = cache.get(rid)
    if v is None or not cents:
        return None, 0.0
    x = _l2(v)
    best, bsim = None, -1.0
    for c, cen in cents.items():
        s = float(x @ _l2(cen))
        if s > bsim:
            best, bsim = c, s
    return best, bsim

def cascade_accept_score(clf, classes, cents, cache, rid, head_tau, cent_tau):
    pred, conf = head_conf(clf, classes, cache, rid)
    if conf >= head_tau:
        return pred, conf, "head"
    cpred, sim = centroid_score(cents, cache, rid)
    if sim >= cent_tau:
        return cpred, sim, "centroid"
    return None, max(conf, sim), "reject"

def rel_mahalanobis(train_items, cache):
    """Shared-covariance Mahalanobis, background-subtracted (RelMaha): accept-score =
    -(dist to nearest class centroid) + mean(dist to the other centroids). Higher =
    more in-set. Covariance fit on the TRAIN split only (no held-out leak)."""
    by = {}
    for it in train_items:
        if it.get("isNegative") or not it["groundTruth"] or cache.get(it["id"]) is None:
            continue
        by.setdefault(it["groundTruth"], []).append(_l2(cache[it["id"]]))
    cents = {c: np.mean(v, axis=0) for c, v in by.items() if v}
    allX = np.array([x for v in by.values() for x in v])
    cov = np.cov(allX.T) + 1e-6 * np.eye(allX.shape[1])
    inv = np.linalg.pinv(cov)
    C = list(cents.items())
    def score(rid):
        v = cache.get(rid)
        if v is None:
            return -1e9
        x = _l2(v)
        ds = []
        for _, cen in C:
            d = x - cen
            ds.append(float(d @ inv @ d))
        ds = np.array(ds)
        near = ds.min()
        rest = (ds.sum() - near) / max(len(ds) - 1, 1)
        return -(near) + rest
    return score
