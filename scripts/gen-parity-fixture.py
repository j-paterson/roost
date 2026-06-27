#!/usr/bin/env python3
"""Generate a deterministic synthetic dataset + sklearn-trained stacked heads as the
TS parity golden fixture. Run once (offline); commit the JSON output. Mirrors
train-stacked-heads.py's algorithm (lbfgs, C=1, balanced, l2-normalized rows, 5-fold OOF meta)."""
import json, numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold

np.random.seed(1729)
DIM, K, PER = 16, 4, 40
classes = [f"Cat{c}" for c in range(K)]
rows, Xt, Xv, y = [], [], [], []
for c in range(K):
    ct = np.zeros(DIM); ct[c] = 2.0
    cv = np.zeros(DIM); cv[(c + 1) % DIM] = 2.0
    for _ in range(PER):
        vt = (ct + np.random.randn(DIM) * 0.5).astype(np.float32)
        vv = (cv + np.random.randn(DIM) * 0.5).astype(np.float32)
        rows.append({"vecText": vt.tolist(), "vecVision": vv.tolist(), "category": classes[c]})
        Xt.append(vt); Xv.append(vv); y.append(classes[c])
Xt = np.array(Xt); Xv = np.array(Xv); y = np.array(y)

def l2(X):
    n = np.linalg.norm(X, axis=1, keepdims=True); n[n == 0] = 1; return X / n
def fit(X, yy):
    clf = LogisticRegression(max_iter=2000, C=1.0, solver="lbfgs", class_weight="balanced")
    clf.fit(l2(X), yy)
    order = list(clf.classes_)
    # reindex coef/intercept to sorted(classes) for a stable contract
    idx = [order.index(c) for c in classes]
    return clf.coef_[idx].tolist(), clf.intercept_[idx].tolist()

def head(X):
    W, b = fit(X, y)
    return {"classes": classes, "W": W, "b": b, "dim": DIM, "norm": "l2", "trainedOn": len(y), "version": 1}

def oof(X):
    P = np.zeros((len(X), K))
    skf = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    Xn = l2(X)
    for tr, va in skf.split(Xn, y):
        clf = LogisticRegression(max_iter=2000, C=1.0, solver="lbfgs", class_weight="balanced")
        clf.fit(Xn[tr], y[tr])
        fc = list(clf.classes_); proba = clf.predict_proba(Xn[va])
        for gi, c in enumerate(classes):
            if c in fc: P[va, gi] = proba[:, fc.index(c)]
    return P

feat = np.hstack([oof(Xt), oof(Xv)])
mclf = LogisticRegression(max_iter=2000, C=1.0, solver="lbfgs", class_weight="balanced")
mclf.fit(feat, y)
mo = list(mclf.classes_); midx = [mo.index(c) for c in classes]
meta = {"classes": classes, "W": mclf.coef_[midx].tolist(), "b": mclf.intercept_[midx].tolist(),
        "inDim": 2 * K, "norm": "none", "version": 1}

out = {"rows": rows, "python": {"text": head(Xt), "vision": head(Xv), "meta": meta}}
import os
p = os.path.join(os.path.dirname(__file__), "..", "packages", "core", "src", "pipeline",
                 "__tests__", "fixtures", "parity-golden.json")
os.makedirs(os.path.dirname(p), exist_ok=True)
json.dump(out, open(p, "w"))
print("wrote", p, "rows:", len(rows))
