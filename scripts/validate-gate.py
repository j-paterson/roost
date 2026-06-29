#!/usr/bin/env python3
"""Acceptance check for the retrain gate methodology (Spec 2 amendment).
Mirrors the TS gate rule (fair baseline + overall & macro non-regression + catastrophic guard,
averaged over k folds) and asserts it (a) PASSES a genuinely-better candidate and (b) REJECTS a
corrupted one.

Run: ROOST_VAULT=<vault> <venv>/python3 scripts/validate-gate.py

Exit 0 = both directions hold (gate is sound — safe to enable auto-retrain).
Exit 2 = gate methodology broken (do NOT enable auto-retrain).
"""
import os, sys, re, glob, json, math, warnings
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold
from collections import Counter
warnings.filterwarnings("ignore"); np.seterr(all="ignore")

V = os.environ.get("ROOST_VAULT")
if not V:
    print("ERROR: ROOST_VAULT environment variable is not set.", file=sys.stderr)
    print("Usage: ROOST_VAULT=/path/to/vault python3 scripts/validate-gate.py", file=sys.stderr)
    sys.exit(1)

C = V + "/.roost/cache"; DIM = 768
EPS = 0.0; CATA = 0.15; MIN_SUP = 20; OOF = 3; KFOLDS = 5  # 5-fold is deliberately more conservative than live GATE_KFOLDS=3: pass here implies soundness at 3


def fm(t, k):
    blk = t.split("---", 2)[1] if t.count("---") >= 2 else ""
    m = re.search(rf'^{k}:\s*"?([^"\n]*)', blk, re.M)
    return m.group(1).strip() if m else ""


def read_bin(p):
    with open(p, "rb") as f:
        ids = json.loads(f.readline())
        d = np.frombuffer(f.read(), np.float32).reshape(len(ids), DIM)
    return {i: d[k] for k, i in enumerate(ids)}


def l2(X):
    n = np.linalg.norm(X, axis=1, keepdims=True); n[n == 0] = 1; return X / n


try:
    vis = read_bin(C + "/embedding-vectors.bin")
    txt = read_bin(C + "/embedding-vectors-text.bin")
except FileNotFoundError as exc:
    print(f"ERROR: missing embedding cache at {exc.filename} — run embeddings first", file=sys.stderr)
    sys.exit(1)
Xt, Xv, y = [], [], []
for p in glob.glob(V + "/Bookmarks/**/*.md", recursive=True):
    t = open(p, encoding="utf-8", errors="ignore").read()
    rid = fm(t, "roost_id")
    if not rid or fm(t, "roost_assigned_by") != "human": continue
    cat = fm(t, "roost_category")
    if not cat or rid not in vis or rid not in txt: continue
    vt, vv = txt[rid], vis[rid]
    if (np.all(np.isfinite(vt)) and np.all(np.isfinite(vv))
            and np.linalg.norm(vt) > 0 and np.linalg.norm(vv) > 0):
        Xt.append(vt); Xv.append(vv); y.append(cat)

Xt = l2(np.array(Xt, np.float32))
Xv = l2(np.array(Xv, np.float32))
y = np.array(y)
print(f"items {len(y)}  RULE: overall & macro-recall both >= -{EPS}, "
      f"no class<-{CATA} (support>={MIN_SUP})  folds {KFOLDS}\n")


def fit(X, yy):
    return LogisticRegression(
        max_iter=2000, C=1.0, solver="lbfgs", class_weight="balanced"
    ).fit(X, yy)


def oofp(X, yy, cl):
    K = len(cl); P = np.zeros((len(X), K))
    k = max(2, min(OOF, min(Counter(yy).values())))
    for tr, va in StratifiedKFold(k, shuffle=True, random_state=42).split(X, yy):
        c = fit(X[tr], yy[tr]); fc = list(c.classes_); pr = c.predict_proba(X[va])
        for gi, cc in enumerate(cl):
            if cc in fc: P[va, gi] = pr[:, fc.index(cc)]
    return P


def train(ti, yy):
    cl = sorted(set(yy))
    th = fit(Xt[ti], yy); vh = fit(Xv[ti], yy)
    mh = fit(np.hstack([oofp(Xt[ti], yy, cl), oofp(Xv[ti], yy, cl)]), yy)
    return cl, th, vh, mh


def align(c, P, cl):
    o = np.zeros((len(P), len(cl)))
    for j, cc in enumerate(c.classes_):
        if cc in cl: o[:, cl.index(cc)] = P[:, j]
    return o


def pred(m, hi):
    cl, th, vh, mh = m
    feat = np.hstack([
        align(th, th.predict_proba(Xt[hi]), cl),
        align(vh, vh.predict_proba(Xv[hi]), cl),
    ])
    mo = list(mh.classes_)
    return np.array([mo[i] for i in mh.predict_proba(feat).argmax(1)])


def metrics(pp, yt):
    ov = (pp == yt).mean()
    pc = {c: (pp[yt == c] == c).mean() for c in sorted(set(yt))}
    return ov, np.mean(list(pc.values())), pc


def gate2(bm, km, hi):
    yt = y[hi]
    ovb, mab, pcb = metrics(pred(bm, hi), yt)
    ovk, mak, pck = metrics(pred(km, hi), yt)
    cata = any(
        int((yt == c).sum()) >= MIN_SUP and (pck[c] - pcb[c]) < -CATA
        for c in pcb
    )
    return ovb, ovk, mab, mak, (ovk >= ovb - EPS and mak >= mab - EPS and not cata)


def run(name, bf, cf, corrupt=0.0):
    OVB = OVK = MAB = MAK = 0; p = 0
    for fold in range(KFOLDS):
        rng = np.random.RandomState(100 + fold); ho = []
        for c in sorted(set(y)):
            ci = np.where(y == c)[0]; rng.shuffle(ci)
            ho += list(ci[:max(1, int(round(len(ci) * 0.2)))])
        ho = np.array(sorted(ho))
        pool = np.array([i for i in range(len(y)) if i not in set(ho)])

        def sub(f):
            s = []
            for c in sorted(set(y[pool])):
                ci = pool[y[pool] == c]; ci = rng.permutation(ci)
                s += list(ci[:max(2, int(round(len(ci) * f)))])
            return np.array(s)

        bi = sub(bf); ki = sub(cf); yb = y[bi].copy(); yk = y[ki].copy()
        if corrupt > 0:
            n = int(len(yk) * corrupt)
            ix = rng.choice(len(yk), n, replace=False)
            yk[ix] = rng.permutation(yk[ix])
        ovb, ovk, mab, mak, passed = gate2(train(bi, yb), train(ki, yk), ho)
        OVB += ovb; OVK += ovk; MAB += mab; MAK += mak; p += int(passed)

    n = KFOLDS
    print(f"[{name}]")
    print(f"  overall {100*OVB/n:.1f}%→{100*OVK/n:.1f}% "
          f"(Δ{100*(OVK-OVB)/n:+.1f})  "
          f"macro {100*MAB/n:.1f}%→{100*MAK/n:.1f}% "
          f"(Δ{100*(MAK-MAB)/n:+.1f})")
    print(f"  gate PASS (macro rule): {p}/{n} folds\n")
    return p


pos = run("POSITIVE: base 25% vs cand 100%", 0.25, 1.0)
neg = run("NEGATIVE CONTROL: cand 40% corrupted", 1.0, 1.0, corrupt=0.40)
run("MARGINAL: base 90% vs cand 100%", 0.90, 1.0)

ok = pos >= math.ceil(0.6 * KFOLDS) and neg == 0
print(
    f"\nACCEPTANCE: positive {pos}/{KFOLDS} (need >= {math.ceil(0.6*KFOLDS)}), "
    f"negative {neg}/{KFOLDS} (need 0)  =>  {'PASS' if ok else 'FAIL'}"
)
sys.exit(0 if ok else 2)
