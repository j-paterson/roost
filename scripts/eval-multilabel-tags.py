#!/usr/bin/env python3
"""Multi-label tag detector evaluation (one-vs-rest, k-fold CV).

Tests the bet behind the tag-system pivot: do INDEPENDENT per-tag detectors
recover rare-but-distinct classes that the single-label softmax cannot?

Ground truth is the human `collection` label (single per item), so we measure
per-class RECALL: for items whose true tag is C, does the multi-tag system
surface C within the top-k independent detectors? (Precision of the EXTRA tags
is not gradeable from single-label GT — that needs the LLM audit.)

5-fold stratified CV (seed 1729) so rare classes (Humor 26, Content Creation 20)
get every example as a held-out test point, never trained on while scored.

Run: ROOST_VAULT=<vault> python scripts/eval-multilabel-tags.py

Result (2026-06-18): overall recall single-label 61% -> multi-tag @2 81% / @3 87%.
Rare classes rescued: Humor 23->73%, Content Creation 35->70%, Growth 23->74%,
Art 39->75%, Design 46->81%. The "unlearnable" verdict was an artifact of the
single-label constraint, not the categories. (Full-canon LLM-NONE got ~0% on the
same rare classes — detectors win decisively.)
"""
import os
import numpy as np
import honest_eval_lib as L
from sklearn.linear_model import LogisticRegression
from sklearn.multiclass import OneVsRestClassifier
from sklearn.model_selection import StratifiedKFold
from collections import Counter


def main():
    vault = os.environ.get("ROOST_VAULT")
    if not vault:
        raise SystemExit("ROOST_VAULT not set")
    cache_bin = os.path.join(vault, ".roost", "cache", "embedding-vectors.bin")

    labels, _ = L.load_honest_labels(vault)  # id -> collection (GT), never roost_category
    cache = L.load_cache(bin_path=cache_bin)

    ids, X, y = [], [], []
    for iid, c in labels.items():
        v = cache.get(iid)
        if v is None:
            continue
        v = np.asarray(v, np.float64)
        n = np.linalg.norm(v)
        if n == 0 or not np.isfinite(v).all():
            continue
        ids.append(iid)
        X.append(v / n)
        y.append(c)
    X = np.array(X)
    y = np.array(y)
    classes = sorted(set(y))
    ci = {c: i for i, c in enumerate(classes)}
    print(f"items={len(y)} classes={len(classes)}")

    skf = StratifiedKFold(5, shuffle=True, random_state=1729)
    ovr_prob = np.zeros((len(y), len(classes)))
    mnl = np.empty(len(y), dtype=object)
    for tr, te in skf.split(X, y):
        ovr = OneVsRestClassifier(
            LogisticRegression(max_iter=1500, C=1, class_weight="balanced"), n_jobs=-1
        )
        ovr.fit(X[tr], y[tr])
        P = ovr.predict_proba(X[te])
        for j, gc in enumerate(ovr.classes_):
            ovr_prob[te, ci[gc]] = P[:, j]
        m = LogisticRegression(max_iter=1500, C=1, class_weight="balanced", n_jobs=-1)
        m.fit(X[tr], y[tr])
        mnl[te] = m.predict(X[te])

    order = np.argsort(-ovr_prob, axis=1)
    ti = np.array([ci[c] for c in y])

    def at(k):
        tk = order[:, :k]
        return np.array([ti[i] in tk[i] for i in range(len(y))])

    h1, h2, h3 = at(1), at(2), at(3)
    mh = mnl == y
    sup = Counter(y)
    print(f"{'class':<18}{'n':>5}{'single':>8}{'ovr@1':>7}{'ovr@2':>7}{'ovr@3':>7}")
    for c in sorted(classes, key=lambda c: sup[c]):
        idx = np.array([j for j in range(len(y)) if y[j] == c])
        print(f"{c:<18}{sup[c]:>5}{100*mh[idx].mean():>7.0f}%"
              f"{100*h1[idx].mean():>6.0f}%{100*h2[idx].mean():>6.0f}%{100*h3[idx].mean():>6.0f}%")
    print(f"\nOVERALL recall: single-label {100*mh.mean():.0f}%  |  "
          f"multi-tag @2 {100*h2.mean():.0f}%  @3 {100*h3.mean():.0f}%")


if __name__ == "__main__":
    main()
