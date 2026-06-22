#!/usr/bin/env python3
"""Test centroid-distance as the vision-gating lever (vs caption-length).

The research surfaced this: instead of gating vision on caption LENGTH, gate on text-embedding
INFORMATIVENESS — how confidently the TEXT-ONLY embedding lands near a category centroid. Thin/ambiguous
text => far from every centroid (low confidence) => add vision; decisive text => close to its centroid
=> skip vision. This is the MMDynamics/AGFN quality-adaptive-fusion idea, with a centroid proxy.

Reuses the 250 video items + qwen cover cache from the keyframe eval (no new describe). Sidecar UP.
  TEST 1  GRADIENT  — vision Δ accuracy by TEXT-ONLY centroid-confidence quartile (no threshold pick).
  TEST 2  GATED     — empty vs cover vs caption-gated vs centroid-gated, multi-class top-1 + McNemar.
  TEST 3  HEAD-TO-HEAD — centroid-gate vs caption-gate directly (which lever wins?).

Confidence is computed OUT-OF-FOLD on the text-only embedding (label-free per item) so the gate never
sees an item's own label. The final classifier is a SEPARATE CV on the gated representation.
Run: ROOST_VAULT=<v> python scripts/exp-centroid-gating.py
"""
import os, glob, re, json, random, urllib.request
import numpy as np, honest_eval_lib as L
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.metrics import accuracy_score
try:
    from scipy.stats import binomtest; ep=lambda b,c: binomtest(min(b,c),b+c,0.5).pvalue if b+c else 1.0
except Exception:
    from scipy.stats import binom_test; ep=lambda b,c: binom_test(min(b,c),b+c,0.5) if b+c else 1.0

def embed(t):
    body=json.dumps({"model":"x","input":[t]}).encode()
    v=json.load(urllib.request.urlopen(urllib.request.Request("http://localhost:11435/api/embed",body,{"Content-Type":"application/json"}),timeout=60))["embeddings"][0]
    v=np.asarray(v,float); return v/(np.linalg.norm(v) or 1)

def oof_centroid_conf(X, yi, ncls, seed=2718):
    """Out-of-fold, per item: (max cosine to nearest centroid, top1-top2 margin). Label-free per item."""
    mx=np.zeros(len(yi)); mg=np.zeros(len(yi))
    for tr,te in StratifiedKFold(5,shuffle=True,random_state=seed).split(X,yi):
        cc=np.array([X[tr][yi[tr]==k].mean(0) for k in range(ncls)]); cc/=np.linalg.norm(cc,axis=1,keepdims=True)+1e-9
        s=X[te]@cc.T; ss=np.sort(s,axis=1)
        mx[te]=ss[:,-1]; mg[te]=ss[:,-1]-ss[:,-2]
    return mx, mg

def main():
    V=os.environ["ROOST_VAULT"]; C=os.path.join(V,".roost","cache")
    labels,_=L.load_honest_labels(V); tcache=json.load(open(C+"/embedding-cache.json"))
    cover=json.load(open(C+"/exp-keyframe-cover.json"))
    info={}
    for p in glob.glob(V+"/Bookmarks/TikTok/**/*.md",recursive=True):
        t=open(p,encoding="utf-8",errors="ignore").read(); m=re.search(r"^roost_id:\s*(tiktok):(\S+)",t,re.M)
        if not m: continue
        fm=t.split('---')[1] if t.count('---')>=2 else ""; tit=re.search(r"^title:\s*(.*)$",fm,re.M); sub=re.search(r"^subtitle:\s*(.*)$",fm,re.M)
        d=os.path.join(os.path.dirname(p),f"tiktok-{m.group(2)}")
        info[f"tiktok:{m.group(2)}"]=dict(title=(tit.group(1).strip().strip('"') if tit else ""),subtitle=(sub.group(1).strip().strip('"') if sub else ""),
                                          has=os.path.exists(os.path.join(d,"video.mp4")) and os.path.exists(os.path.join(d,"cover.jpg")))
    random.seed(1729)
    pool=[i for i in labels if i in tcache and i in info and info[i]["has"] and i in cover]
    random.shuffle(pool)
    from collections import Counter
    cnt=Counter(labels[i] for i in pool[:600]); keep={c for c,k in cnt.items() if k>=6}
    sample=[i for i in pool if labels[i] in keep][:250]
    def caption(i): e=tcache[i]; it=info[i]; return " ".join(x for x in [e.get("summary"),e.get("category"),it["title"],it["subtitle"]] if x)
    def etext(vis,i): c=caption(i); return (vis+" "+c).strip() if vis else c
    clen=np.array([len(caption(i)) for i in sample])

    Xe=np.array([embed(etext("",i)) for i in sample])                     # text-only (no vision)
    Xc=np.array([embed(etext(cover.get(i,""),i)) for i in sample])        # + qwen cover vision
    y=np.array([labels[i] for i in sample]); cls=sorted(set(y)); yi=np.array([cls.index(c) for c in y])
    skf=StratifiedKFold(5,shuffle=True,random_state=1729)
    def preds(X): return cross_val_predict(LogisticRegression(max_iter=1500,C=1.0,class_weight="balanced"),X,yi,cv=skf,n_jobs=-1)
    pe,pc=preds(Xe),preds(Xc); ce=(pe==yi); cc=(pc==yi)

    # text-only centroid confidence, out-of-fold (the gating signal)
    conf_mx, conf_mg = oof_centroid_conf(Xe, yi, len(cls))
    print(f"items: {len(sample)}  | text-only centroid max-cos: median {np.median(conf_mx):.3f} (min {conf_mx.min():.3f}, max {conf_mx.max():.3f})")
    print(f"corr(caption-length, centroid-confidence) = {np.corrcoef(clen, conf_mx)[0,1]:+.2f}   (if ~0, the two levers see different items)")

    print("\n=== TEST 1: GRADIENT — vision Δ by TEXT-ONLY centroid-confidence quartile ===")
    print("    (low conf = text lands far from any centroid = ambiguous; expect vision to help here)")
    for sig_name, sig in (("max-cos", conf_mx), ("margin", conf_mg)):
        print(f"  -- confidence = {sig_name} --")
        q=np.quantile(sig,[0,.25,.5,.75,1.0])
        for k in range(4):
            ix=np.where((sig>=q[k])&(sig<=q[k+1]) if k==3 else (sig>=q[k])&(sig<q[k+1]))[0]
            if len(ix)<5: continue
            ae=ce[ix].mean(); ac=cc[ix].mean()
            print(f"    Q{k+1} conf {q[k]:.3f}-{q[k+1]:.3f} (n={len(ix)}): empty {ae:.2f} -> cover {ac:.2f}  vision Δ {(ac-ae)*100:+.0f}pp")

    print("\n=== TEST 2: GATED representations vs always-on/off ===")
    medL=np.median(clen); thinL=clen<medL                                # caption-length gate
    medC=np.median(conf_mx); thinC=conf_mx<medC                          # centroid-confidence gate
    XgL=np.where(thinL[:,None],Xc,Xe); XgC=np.where(thinC[:,None],Xc,Xe)
    pgL,pgC=preds(XgL),preds(XgC); cgL=(pgL==yi); cgC=(pgC==yi)
    rows=[("always-empty",pe),("always-cover",pc),("caption-gated",pgL),("centroid-gated",pgC)]
    for nm,p in rows: print(f"  {nm:15}: {accuracy_score(yi,p):.3f}")
    print("  -- McNemar vs always-empty / always-cover --")
    for nm,cg in (("caption-gated",cgL),("centroid-gated",cgC)):
        for bnm,base in (("empty",ce),("cover",cc)):
            b=int((~base & cg).sum()); c=int((base & ~cg).sum())
            print(f"    {nm} vs {bnm}: gated-only-correct={b} other-only-correct={c}  McNemar p={ep(b,c):.3f}")

    print("\n=== TEST 3: HEAD-TO-HEAD — centroid-gate vs caption-gate ===")
    b=int((~cgL & cgC).sum()); c=int((cgL & ~cgC).sum())
    print(f"  centroid-only-correct={b} caption-only-correct={c}  McNemar p={ep(b,c):.3f}")
    agree=int((thinL==thinC).sum())
    print(f"  gates agree on {agree}/{len(sample)} items ({agree/len(sample)*100:.0f}%) about whether to add vision")

    print("\n=== TEST 4: THRESHOLD SWEEP — add cover to the bottom-q fraction (does narrow centroid gate win?) ===")
    print("    (gradient said only Q1 benefits / Q4 is hurt — so a bottom-25% gate may beat median split)")
    for signame, sig, lo_is_thin in (("centroid", conf_mx, True), ("caption-len", clen.astype(float), False)):
        # lo_is_thin: for centroid, LOW confidence = thin = add vision; for caption, LOW length = thin
        print(f"  -- {signame} gate --")
        for frac in (0.10, 0.25, 0.50):
            thr=np.quantile(sig, frac if lo_is_thin else frac)
            thin = sig < thr                                   # bottom-frac get cover
            Xg=np.where(thin[:,None],Xc,Xe); pg=preds(Xg); cg=(pg==yi)
            bb=int((~ce & cg).sum()); ccx=int((ce & ~cg).sum())
            print(f"    bottom {int(frac*100):>2}% get cover (n={int(thin.sum())}): acc {accuracy_score(yi,pg):.3f}  vs empty McNemar p={ep(bb,ccx):.3f} (gain {bb} lose {ccx})")

    print("\n=== TEST 5: COMBINED gate — two uncorrelated signals stacked (caption-thin OR/AND centroid-low) ===")
    # best widths found: caption bottom-50%, centroid bottom-25%
    tL = clen < np.quantile(clen, 0.50)          # caption-thin (bottom 50%)
    tC = conf_mx < np.quantile(conf_mx, 0.25)    # centroid-low (bottom 25%)
    for combo, mask in (("UNION (thin OR low)", tL | tC), ("INTERSECT (thin AND low)", tL & tC)):
        Xg=np.where(mask[:,None],Xc,Xe); pg=preds(Xg); cg=(pg==yi)
        bb=int((~ce & cg).sum()); ccx=int((ce & ~cg).sum())
        print(f"  {combo:24} cover n={int(mask.sum()):3}: acc {accuracy_score(yi,pg):.3f}  vs empty McNemar p={ep(bb,ccx):.3f} (gain {bb} lose {ccx})")
    print(f"  (reference) caption-only bottom-50% : acc {accuracy_score(yi,pgL):.3f}   always-empty: {accuracy_score(yi,pe):.3f}")

if __name__=="__main__": main()
