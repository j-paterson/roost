#!/usr/bin/env python3
"""Head-to-head gating mechanisms, per platform, with leakage guards.

Compares, via 5-fold CV on the 900-item human-labeled sets (sidecar UP, reuses cached cover
descriptions — no new describes):
  always-empty   — LogReg on text-only embedding
  always-cover   — LogReg on vision-on embedding
  length-gate    — vision-on iff caption < median, else text-only
  cascade(nested)— text-only provisional pred; if pred in a vision-helps set, take vision-on pred.
                   The helps-set is derived from INNER folds only (nested CV), per the adversarial
                   review, so the set is not fit on the data it's scored on.
  stacking       — meta-LogReg over concatenated OUT-OF-FOLD base logits [text proba | vision proba].
                   Non-circular by construction; the principled version of per-category triggering.
McNemar of cascade and stacking vs always-empty and always-cover.
Run: ROOST_VAULT=<v> python scripts/exp-stacking-cascade.py
"""
import os, json, importlib.util
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
    t=t.encode("utf-8","ignore").decode("utf-8")[:10000]   # surrogate-safe + cap (matches prod fix)
    body=json.dumps({"model":"x","input":[t]}).encode()
    for k in range(6):
        try:
            v=json.load(urllib.request.urlopen(urllib.request.Request("http://localhost:11435/api/embed",body,{"Content-Type":"application/json"}),timeout=60))["embeddings"][0]
            v=np.asarray(v,float); return v/(np.linalg.norm(v) or 1)
        except Exception:
            if k==5: raise
            import time; time.sleep(2.0*(k+1))

def newLR(): return LogisticRegression(max_iter=1500,C=1.0,class_weight="balanced")

def oof(X, yi, ncls, seed):
    """Out-of-fold full-width proba + hard pred."""
    P=np.zeros((len(yi),ncls)); pred=np.zeros(len(yi),int)
    for tr,te in StratifiedKFold(5,shuffle=True,random_state=seed).split(X,yi):
        m=newLR().fit(X[tr],yi[tr])
        P[np.ix_(te,m.classes_)]=m.predict_proba(X[te]); pred[te]=m.predict(X[te])
    return P,pred

def nested_cascade(Xe,Xc,yi,ncls,margin=0.05,minn=20):
    final=np.zeros(len(yi),int); helps_log=[]
    for tr,te in StratifiedKFold(5,shuffle=True,random_state=1729).split(Xe,yi):
        ytr=yi[tr]
        _,pe_in=oof(Xe[tr],ytr,ncls,seed=99); _,pc_in=oof(Xc[tr],ytr,ncls,seed=99)   # inner OOF on TRAIN only
        helps=set()
        for c in range(ncls):
            idx=np.where(ytr==c)[0]
            if len(idx)>=minn:
                de=(pe_in[idx]==c).mean(); dc=(pc_in[idx]==c).mean()
                if dc-de>margin: helps.add(c)
        helps_log.append(len(helps))
        me=newLR().fit(Xe[tr],ytr); mc=newLR().fit(Xc[tr],ytr)
        pe_te=me.predict(Xe[te]); pc_te=mc.predict(Xc[te])
        final[te]=np.array([pc_te[j] if pe_te[j] in helps else pe_te[j] for j in range(len(te))])
    return final, np.mean(helps_log)

def run(plat, mod, cover_path, capfn):
    samp,labels,tcache,info=mod.sample(V)
    cover=json.load(open(cover_path)) if os.path.exists(cover_path) else {}
    clen=np.array([len(capfn(i,tcache,info)) for i in samp])
    Xe=np.array([embed(capfn(i,tcache,info)) for i in samp])
    Xc=np.array([embed(((cover.get(i,"")+" ")+capfn(i,tcache,info)).strip()) for i in samp])
    y=np.array([labels[i] for i in samp]); cls=sorted(set(y)); yi=np.array([cls.index(c) for c in y]); ncls=len(cls)
    Pe,pe=oof(Xe,yi,ncls,1729); Pc,pc=oof(Xc,yi,ncls,1729)
    thin=clen<np.median(clen); Xg=np.where(thin[:,None],Xc,Xe); _,pg=oof(Xg,yi,ncls,1729)
    pcasc,avg_helps=nested_cascade(Xe,Xc,yi,ncls)
    _,pstack=oof(np.hstack([Pe,Pc]),yi,ncls,1729)   # meta over OOF base logits
    acc=lambda p:(p==yi).mean()
    methods=[("always-empty",pe),("always-cover",pc),("length-gate",pg),("cascade(nested)",pcasc),("stacking",pstack)]
    print(f"\n########## {plat}  (n={len(samp)}, {ncls} cats, avg helps-set size {avg_helps:.1f}) ##########")
    for nm,p in methods: print(f"  {nm:16}: {acc(p):.3f}")
    print("  -- McNemar vs always-empty / always-cover --")
    ce=(pe==yi); cc=(pc==yi)
    for nm,p in (("length-gate",pg),("cascade(nested)",pcasc),("stacking",pstack)):
        cp=(p==yi)
        for bnm,base in (("empty",ce),("cover",cc)):
            b=int((~base&cp).sum()); c=int((base&~cp).sum())
            print(f"    {nm:16} vs {bnm}: +{b} -{c}  McNemar p={ep(b,c):.3f}")

def cap_tk(i,tcache,info): e=tcache[i]; it=info[i]; return " ".join(x for x in [e.get('summary'),e.get('category'),it['title'],it['subtitle']] if x)
def cap_tw(i,tcache,info): e=tcache[i]; it=info[i]; return " ".join(x for x in [it['title'],e.get('summary'),e.get('category')] if x)

if __name__=="__main__":
    run("TikTok", TK, C+"/exp-keyframe-cover.json", cap_tk)
    run("Twitter", TW, C+"/exp-twitter-cover.json", cap_tw)
