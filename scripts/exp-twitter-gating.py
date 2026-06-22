#!/usr/bin/env python3
"""Twitter/X caption-gated-vision eval — does the TikTok gating result transfer to text-heavy tweets?

Mirrors the TikTok eval (exp-validate-caption-gating.py / exp-keyframe-vs-cover.py) on X items so the
two platforms are directly comparable. X differs from TikTok: the "caption" is the TWEET BODY (the .md
`title`, often a full paragraph) + summary; no subtitle; categories skew text-heavy (Tech/Design/Growth)
— exactly the region where vision HURT on TikTok. So we measure rather than assume transfer.

Two phases (memory staging — qwen + sidecar OOM 24 GB together):
  --phase describe : qwen-on-cover for each X item (run with the embed sidecar DOWN). Resumable.
  --phase embed    : empty-vs-cover embeddings + gradient/gated/McNemar (run with the sidecar UP).
Sample: X human-labeled items that have a resolvable cover image and a cache entry.
Run: ROOST_VAULT=<v> python scripts/exp-twitter-gating.py --phase describe   (sidecar down)
     ROOST_VAULT=<v> python scripts/exp-twitter-gating.py --phase embed      (sidecar up)
"""
import os, glob, re, json, base64, random, argparse, urllib.request
from collections import Counter
import numpy as np, honest_eval_lib as L
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.metrics import accuracy_score
try:
    from scipy.stats import binomtest; ep=lambda b,c: binomtest(min(b,c),b+c,0.5).pvalue if b+c else 1.0
except Exception:
    from scipy.stats import binom_test; ep=lambda b,c: binom_test(min(b,c),b+c,0.5) if b+c else 1.0

OLLAMA="http://localhost:11434"; SIDECAR="http://localhost:11435"
MODEL="huihui_ai/qwen2.5-vl-abliterated:latest"; NUM_CTX=4096; N_CAP=900   # powered subsample (clears p<0.05; full pool was ~7h)

def b64(p): return base64.b64encode(open(p,"rb").read()).decode()
def qwen(img_path):
    body=json.dumps({"model":MODEL,"prompt":"Describe what is happening in this image in two or three sentences.",
                     "images":[b64(img_path)],"stream":False,"options":{"num_ctx":NUM_CTX}}).encode()
    try: return json.load(urllib.request.urlopen(urllib.request.Request(OLLAMA+"/api/generate",body,{"Content-Type":"application/json"}),timeout=240)).get("response","").strip()
    except Exception: return ""
def embed(t):
    body=json.dumps({"model":"x","input":[t]}).encode()
    v=json.load(urllib.request.urlopen(urllib.request.Request(SIDECAR+"/api/embed",body,{"Content-Type":"application/json"}),timeout=60))["embeddings"][0]
    v=np.asarray(v,float); return v/(np.linalg.norm(v) or 1)

def build_info(V):
    """twitter:<id> -> {title (tweet body), cover (abs image path or None)}."""
    info={}
    for p in glob.glob(V+"/Bookmarks/X/*.md"):
        t=open(p,encoding="utf-8",errors="ignore").read()
        m=re.search(r"^roost_id:\s*twitter:(\S+)",t,re.M)
        if not m: continue
        iid=f"twitter:{m.group(1)}"; num=m.group(1)
        tit=re.search(r"^title:\s*(.*)$",t,re.M)
        cov=re.search(r"^cover:\s*\"?\[\[([^\]]+)\]\]\"?",t,re.M)
        cover=None
        if cov:
            cp=os.path.join(V,cov.group(1))
            if os.path.exists(cp): cover=cp
        if not cover:
            d=os.path.join(V,"Bookmarks","X",f"twitter-{num}")
            for cand in ("media.jpg","1.jpg","video-poster.jpg","cover.jpg"):
                cp=os.path.join(d,cand)
                if os.path.exists(cp): cover=cp; break
        info[iid]=dict(title=(tit.group(1).strip().strip('"') if tit else ""), cover=cover)
    return info

def sample(V):
    labels,_=L.load_honest_labels(V); tcache=json.load(open(V+"/.roost/cache/embedding-cache.json"))
    info=build_info(V)
    random.seed(1729)
    pool=[i for i in labels if i.startswith("twitter:") and i in tcache and i in info and info[i]["cover"]]
    random.shuffle(pool)
    cnt=Counter(labels[i] for i in pool); keep={c for c,k in cnt.items() if k>=6}
    samp=[i for i in pool if labels[i] in keep][:N_CAP]
    return samp, labels, tcache, info

def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--phase",choices=["describe","embed"],required=True)
    PHASE=ap.parse_args().phase
    V=os.environ["ROOST_VAULT"]; C=os.path.join(V,".roost","cache"); CACHE=C+"/exp-twitter-cover.json"
    samp, labels, tcache, info = sample(V)
    print(f"X eval sample: {len(samp)} items | cats: {sorted(set(labels[i] for i in samp))}")

    cover=json.load(open(CACHE)) if os.path.exists(CACHE) else {}
    if PHASE=="describe":
        todo=[i for i in samp if i not in cover]
        print(f"describing {len(todo)} covers with qwen (num_ctx {NUM_CTX}) — sidecar should be DOWN ...")
        for n,iid in enumerate(todo):
            cover[iid]=qwen(info[iid]["cover"])
            if n%20==0: json.dump(cover,open(CACHE,"w")); print(f"  {n}/{len(todo)}")
        json.dump(cover,open(CACHE,"w"))
        print("=== describe done — bring the sidecar UP, then run --phase embed ===")
        return

    # ---- embed phase ----
    def caption(i): e=tcache[i]; return " ".join(x for x in [info[i]["title"], e.get("summary"), e.get("category")] if x)
    def etext(vis,i): c=caption(i); return (vis+" "+c).strip() if vis else c
    clen=np.array([len(caption(i)) for i in samp])
    Xe=np.array([embed(etext("",i)) for i in samp])
    Xc=np.array([embed(etext(cover.get(i,""),i)) for i in samp])
    y=np.array([labels[i] for i in samp]); cls=sorted(set(y)); yi=np.array([cls.index(c) for c in y])
    skf=StratifiedKFold(5,shuffle=True,random_state=1729)
    def preds(X): return cross_val_predict(LogisticRegression(max_iter=1500,C=1.0,class_weight="balanced"),X,yi,cv=skf,n_jobs=-1)
    pe,pc=preds(Xe),preds(Xc); ce=(pe==yi); cc=(pc==yi)
    print(f"caption length: median {int(np.median(clen))} chars (min {clen.min()}, max {clen.max()})")

    print("\n=== TEST 1: GRADIENT — vision Δ by caption-length quartile (X) ===")
    q=np.quantile(clen,[0,.25,.5,.75,1.0])
    for k in range(4):
        ix=np.where((clen>=q[k])&(clen<=q[k+1]) if k==3 else (clen>=q[k])&(clen<q[k+1]))[0]
        if len(ix)<5: continue
        print(f"  Q{k+1} caption {int(q[k])}-{int(q[k+1])} chars (n={len(ix)}): empty {ce[ix].mean():.2f} -> cover {cc[ix].mean():.2f}  vision Δ {(cc[ix].mean()-ce[ix].mean())*100:+.0f}pp")

    print("\n=== TEST 2: GATED (cover if caption < median, else empty) vs always-on/off (X) ===")
    thin=clen<np.median(clen); Xg=np.where(thin[:,None],Xc,Xe); pg=preds(Xg); cg=(pg==yi)
    print(f"  always-empty : {accuracy_score(yi,pe):.3f}")
    print(f"  always-cover : {accuracy_score(yi,pc):.3f}")
    print(f"  caption-gated: {accuracy_score(yi,pg):.3f}")
    for nm,base in (("vs empty",ce),("vs cover",cc)):
        b=int((~base & cg).sum()); c=int((base & ~cg).sum())
        print(f"  gated {nm}: gated-only-correct={b} other-only-correct={c}  McNemar p={ep(b,c):.3f}")

    print("\n=== TEST 3: per-category cover vs empty (which X cats benefit?) ===")
    out=[(c,ix,float(np.mean([pe[j]==yi[j] for j in ix])),float(np.mean([pc[j]==yi[j] for j in ix])))
         for c in sorted(set(y)) for ix in [[j for j in range(len(y)) if y[j]==c]] if len(ix)>=6]
    for c,ix,ao,ac in sorted(out,key=lambda r:-(r[3]-r[2])):
        print(f"  {c:18} n={len(ix):3}  empty {ao:.2f} -> cover {ac:.2f}  ({(ac-ao)*100:+.0f}pp)")

if __name__=="__main__": main()
