#!/usr/bin/env python3
"""Does the vision win survive under NEAREST-CENTROID (the default Smart Assign classifier)?

All prior gating numbers used LogReg (the optional, default-OFF classifier head). Production's
DEFAULT path is nearest-centroid. This re-runs the comparison under centroid scoring so the spec
rests on the regime users actually run.

CENTROID HYGIENE (per the review note "consider what state the centroids were built from"):
  - Centroids are built FRESH, per-fold, from each arm's OWN embeddings (empty-arm centroids from
    text-only embeddings; cover-arm from vision-on; gated-arm from the gated embeddings).
  - Built from the held-in TRAIN fold only, scored on the held-out fold (no leakage).
  - Built from the 900 HUMAN-labeled items only. No production/stale centroids are reused — those
    may have been built from a different embedding state (cf. the RAW-embedding fallback episode).

Methods (all centroid-based unless noted):
  empty-centroid / cover-centroid / length-gate-centroid
  stacking-centroid — meta-LogReg over concatenated OOF cosine-sims to [empty centroids | cover
                      centroids]. (Stacking always needs a small learned layer; here the BASE is
                      centroid, so it's viable without the LogReg head.)
For reference each platform also prints the LogReg empty/cover (already known) to show the regime gap.
Run: ROOST_VAULT=<v> python scripts/exp-centroid-regime.py
"""
import os, json, importlib.util, time
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold
import urllib.request
try:
    from scipy.stats import binomtest; ep=lambda b,c: binomtest(min(b,c),b+c,0.5).pvalue if b+c else 1.0
except Exception:
    from scipy.stats import binom_test; ep=lambda b,c: binom_test(min(b,c),b+c,0.5) if b+c else 1.0

V=os.environ["ROOST_VAULT"]; C=os.path.join(V,".roost","cache")
def loadmod(n,p):
    s=importlib.util.spec_from_file_location(n,p); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
SD=os.path.dirname(os.path.abspath(__file__))
TK=loadmod("tkm",SD+"/exp-tiktok-gating.py"); TW=loadmod("twm",SD+"/exp-twitter-gating.py")

def embed(t):
    t=t.encode("utf-8","ignore").decode("utf-8")[:10000]
    body=json.dumps({"model":"x","input":[t]}).encode()
    for k in range(6):
        try:
            v=json.load(urllib.request.urlopen(urllib.request.Request("http://localhost:11435/api/embed",body,{"Content-Type":"application/json"}),timeout=60))["embeddings"][0]
            v=np.asarray(v,float); return v/(np.linalg.norm(v) or 1)
        except Exception:
            if k==5: raise
            time.sleep(2.0*(k+1))

def centroids(Xtr, ytr, ncls):
    Cc=np.zeros((ncls,Xtr.shape[1]))
    for k in range(ncls):
        idx=np.where(ytr==k)[0]
        if len(idx): Cc[k]=Xtr[idx].mean(0)
    n=np.linalg.norm(Cc,axis=1,keepdims=True); n[n==0]=1; return Cc/n

def cent_pred(X, yi, ncls, seed=1729):
    pred=np.zeros(len(yi),int)
    for tr,te in StratifiedKFold(5,shuffle=True,random_state=seed).split(X,yi):
        Cc=centroids(X[tr],yi[tr],ncls); pred[te]=(X[te]@Cc.T).argmax(1)
    return pred

def cent_sims(X, yi, ncls, seed=1729):
    S=np.zeros((len(yi),ncls))
    for tr,te in StratifiedKFold(5,shuffle=True,random_state=seed).split(X,yi):
        Cc=centroids(X[tr],yi[tr],ncls); S[te]=X[te]@Cc.T
    return S

def meta_oof(F, yi, ncls, seed=1729):
    pred=np.zeros(len(yi),int)
    for tr,te in StratifiedKFold(5,shuffle=True,random_state=seed).split(F,yi):
        m=LogisticRegression(max_iter=1500,C=1.0,class_weight="balanced").fit(F[tr],yi[tr])
        pred[te]=m.predict(F[te])
    return pred

def lr_pred(X, yi, seed=1729):
    from sklearn.model_selection import cross_val_predict
    return cross_val_predict(LogisticRegression(max_iter=1500,C=1.0,class_weight="balanced"),X,yi,
                             cv=StratifiedKFold(5,shuffle=True,random_state=seed))

def inner_helps(Xe, Xc, yi, ncls, margin, minn, seed=99):
    """Per-category vision-helps set under centroid scoring, from inner CV on TRAIN only (nested)."""
    pe=cent_pred(Xe,yi,ncls,seed); pc=cent_pred(Xc,yi,ncls,seed); helps=set()
    for c in range(ncls):
        idx=np.where(yi==c)[0]
        if len(idx)>=minn:
            if (pc[idx]==c).mean()-(pe[idx]==c).mean()>margin: helps.add(c)
    return helps

def hybrid_centroid_pred(Xe, Xc, yi, ncls, margin=0.03, minn=20, seed=1729):
    """Per-category hybrid centroid bank: vision-built centroid for vision-helps cats, text-built
    otherwise; score each item's MATCHING embedding (vision-emb vs vision centroids, text-emb vs text
    centroids) and argmax across the whole bank. helps-set derived per outer fold from inner CV (nested).
    No provisional prediction → none of the cascade's misrouting. Returns preds + avg helps-set size."""
    pred=np.zeros(len(yi),int); sizes=[]
    for tr,te in StratifiedKFold(5,shuffle=True,random_state=seed).split(Xe,yi):
        ytr=yi[tr]; helps=inner_helps(Xe[tr],Xc[tr],ytr,ncls,margin,minn); sizes.append(len(helps))
        Ce=centroids(Xe[tr],ytr,ncls); Cc=centroids(Xc[tr],ytr,ncls)
        sims=np.zeros((len(te),ncls))
        for k in range(ncls):
            Xi = Xc[te] if k in helps else Xe[te]
            sims[:,k]=Xi@(Cc[k] if k in helps else Ce[k])
        pred[te]=sims.argmax(1)
    return pred, float(np.mean(sizes))

def run(plat, mod, cover_path, capfn):
    samp,labels,tcache,info=mod.sample(V)
    cover=json.load(open(cover_path)) if os.path.exists(cover_path) else {}
    cap=[capfn(i,tcache,info) for i in samp]; clen=np.array([len(c) for c in cap])
    Xe=np.array([embed(c) for c in cap])
    Xc=np.array([embed(((cover.get(i,"")+" ")+c).strip()) for i,c in zip(samp,cap)])
    y=np.array([labels[i] for i in samp]); cls=sorted(set(y)); yi=np.array([cls.index(c) for c in y]); ncls=len(cls)
    thin=clen<np.median(clen); Xg=np.where(thin[:,None],Xc,Xe)
    acc=lambda p:(p==yi).mean()

    pe_c=cent_pred(Xe,yi,ncls); pc_c=cent_pred(Xc,yi,ncls); pg_c=cent_pred(Xg,yi,ncls)
    Se=cent_sims(Xe,yi,ncls); Sc=cent_sims(Xc,yi,ncls); pstack_c=meta_oof(np.hstack([Se,Sc]),yi,ncls)
    phyb_c,hyb_sz=hybrid_centroid_pred(Xe,Xc,yi,ncls)
    pe_lr=lr_pred(Xe,yi); pc_lr=lr_pred(Xc,yi)   # reference (the regime our earlier numbers used)

    print(f"\n########## {plat}  (n={len(samp)}, {ncls} cats) ##########")
    print("  -- NEAREST-CENTROID (production default) --")
    for nm,p in (("empty-centroid",pe_c),("cover-centroid",pc_c),("length-gate-centroid",pg_c),
                 ("stacking-centroid",pstack_c),(f"hybrid-bank-centroid (helps~{hyb_sz:.1f})",phyb_c)):
        print(f"    {nm:34}: {acc(p):.3f}")
    print(f"  -- LogReg reference (head, default-OFF): empty {acc(pe_lr):.3f}  cover {acc(pc_lr):.3f}")
    print("  -- McNemar (centroid regime) --")
    ce=(pe_c==yi); cc=(pc_c==yi)
    for nm,p in (("length-gate-centroid",pg_c),("stacking-centroid",pstack_c),("hybrid-bank-centroid",phyb_c)):
        cp=(p==yi)
        for bnm,base in (("empty",ce),("cover",cc)):
            b=int((~base&cp).sum()); c=int((base&~cp).sum())
            print(f"    {nm:22} vs {bnm}: +{b} -{c}  McNemar p={ep(b,c):.3f}")

def cap_tk(i,tcache,info): e=tcache[i]; it=info[i]; return " ".join(x for x in [e.get('summary'),e.get('category'),it['title'],it['subtitle']] if x)
def cap_tw(i,tcache,info): e=tcache[i]; it=info[i]; return " ".join(x for x in [it['title'],e.get('summary'),e.get('category')] if x)

if __name__=="__main__":
    run("TikTok", TK, C+"/exp-keyframe-cover.json", cap_tk)
    run("Twitter", TW, C+"/exp-twitter-cover.json", cap_tw)
