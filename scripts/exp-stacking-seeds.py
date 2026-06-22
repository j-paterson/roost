#!/usr/bin/env python3
"""Repeated-seed robustness of uniform stacking (LogReg head regime), both platforms.

The stacking decision rests on seed-1729 numbers. Embed once, then loop many seeds varying the CV
split; report the stacking-vs-empty accuracy delta distribution and how often it's positive. Cheap
insurance before speccing. Run with sidecar UP.
"""
import os, json, importlib.util, time
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold
import urllib.request

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

def oof(X, yi, ncls, seed):
    P=np.zeros((len(yi),ncls)); pred=np.zeros(len(yi),int)
    for tr,te in StratifiedKFold(5,shuffle=True,random_state=seed).split(X,yi):
        m=LogisticRegression(max_iter=1500,C=1.0,class_weight="balanced").fit(X[tr],yi[tr])
        P[np.ix_(te,m.classes_)]=m.predict_proba(X[te]); pred[te]=m.predict(X[te])
    return P,pred

def run(plat, mod, cover_path, capfn, seeds):
    samp,labels,tcache,info=mod.sample(V)
    cover=json.load(open(cover_path)) if os.path.exists(cover_path) else {}
    cap=[capfn(i,tcache,info) for i in samp]
    Xe=np.array([embed(c) for c in cap])
    Xc=np.array([embed(((cover.get(i,"")+" ")+c).strip()) for i,c in zip(samp,cap)])
    y=np.array([labels[i] for i in samp]); cls=sorted(set(y)); yi=np.array([cls.index(c) for c in y]); ncls=len(cls)
    deltas=[]; se=[]; ss=[]
    for s in seeds:
        Pe,pe=oof(Xe,yi,ncls,s); Pc,_=oof(Xc,yi,ncls,s)
        _,pstack=oof(np.hstack([Pe,Pc]),yi,ncls,s)
        ae=(pe==yi).mean(); as_=(pstack==yi).mean()
        se.append(ae); ss.append(as_); deltas.append((as_-ae)*100)
    d=np.array(deltas)
    print(f"\n{plat} (n={len(samp)}): empty {np.mean(se):.3f}  stacking {np.mean(ss):.3f}")
    print(f"  stacking-empty Δ over {len(seeds)} seeds: mean {d.mean():+.1f}pp  range [{d.min():+.1f},{d.max():+.1f}]  positive {int((d>0).sum())}/{len(seeds)}")

def cap_tk(i,tcache,info): e=tcache[i]; it=info[i]; return " ".join(x for x in [e.get('summary'),e.get('category'),it['title'],it['subtitle']] if x)
def cap_tw(i,tcache,info): e=tcache[i]; it=info[i]; return " ".join(x for x in [it['title'],e.get('summary'),e.get('category')] if x)

if __name__=="__main__":
    seeds=list(range(1729,1739))
    run("TikTok", TK, C+"/exp-keyframe-cover.json", cap_tk, seeds)
    run("Twitter", TW, C+"/exp-twitter-cover.json", cap_tw, seeds)
