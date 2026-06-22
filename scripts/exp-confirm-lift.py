#!/usr/bin/env python3
"""Confirmation: is the re-describe Spicy lift statistically real, and is qwen's apparent edge real?

Item-level PAIRED test (McNemar) on the Spicy items — caught vs missed under OLD vs NEW vision at a
fixed 10%-FPR operating point — per captioner, under LogReg AND nearest-centroid. Plus a repeated-CV
stable point estimate (the 5-fold single-split was the underpowered thing). Plus a direct
qwen-vs-minicpm paired comparison. Pure re-analysis of the persisted emb-*.npz — no re-describe/re-embed.
"""
import os, glob, numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold
try:
    from scipy.stats import binomtest
    def exact_p(b,c): return binomtest(min(b,c), b+c, 0.5).pvalue if (b+c)>0 else 1.0
except Exception:
    from scipy.stats import binom_test
    def exact_p(b,c): return binom_test(min(b,c), b+c, 0.5) if (b+c)>0 else 1.0

D=os.path.join(os.environ["ROOST_VAULT"],".roost","cache","redescribe-exp")

def oof(X,y,kind,seed):
    s=np.zeros(len(y))
    for tr,te in StratifiedKFold(5,shuffle=True,random_state=seed).split(X,y):
        if kind=="logreg":
            s[te]=LogisticRegression(max_iter=1500,C=1.0,class_weight="balanced").fit(X[tr],y[tr]).predict_proba(X[te])[:,1]
        else:
            cs=X[tr][y[tr]==1].mean(0); cs/=np.linalg.norm(cs) or 1
            cr=X[tr][y[tr]==0].mean(0); cr/=np.linalg.norm(cr) or 1
            s[te]=X[te]@cs - X[te]@cr
    return s

def caught(score,y):                     # boolean per item at the 10%-FPR threshold
    return score >= np.quantile(score[y==0],0.90)

def mcnemar(oc,nc,y):                     # among Spicy items only
    sp=y==1; oc,nc=oc[sp],nc[sp]
    b=int(((~oc)&nc).sum()); c=int((oc&(~nc)).sum())   # b=rescues(old miss→new catch), c=regressions
    return b,c,exact_p(b,c), float(oc.mean()), float(nc.mean())

print("=== Is each captioner's OLD→NEW lift real? (paired McNemar on Spicy items) ===")
store={}
for f in sorted(glob.glob(D+"/emb-*.npz")):
    d=np.load(f,allow_pickle=True); Xo,Xn,y=d["Xold"],d["Xnew"],d["y"].astype(int)
    tag=os.path.basename(f)[4:-4].replace("huihui_ai_qwen2.5-vl-abliterated_latest","qwen")
    store[tag]=(Xn,y)
    print(f"\n[{tag}]  ({(y==1).sum()} Spicy, {(y==0).sum()} non-Spicy)")
    for kind in ("logreg","centroid"):
        b,c,p,ro,rn=mcnemar(caught(oof(Xo,y,kind,1729),y), caught(oof(Xn,y,kind,1729),y), y)
        sig = "SIGNIFICANT" if p<0.05 else "not significant"
        print(f"  {kind:8}: recall {ro:.2f}->{rn:.2f}   rescues={b} regress={c}   McNemar p={p:.3f}  ({sig})")
    # repeated-CV stable delta (logreg)
    ds=[]
    for s in range(40):
        ds.append(caught(oof(Xn,y,"logreg",s),y)[y==1].mean()-caught(oof(Xo,y,"logreg",s),y)[y==1].mean())
    ds=np.array(ds)*100
    print(f"  repeated-CV(40x) logreg recall Δ: mean {ds.mean():+.1f}pp  CI[{np.percentile(ds,2.5):+.1f},{np.percentile(ds,97.5):+.1f}]")

print("\n=== Is qwen actually better than minicpm-v? (direct paired, on the SAME Spicy items) ===")
if "minicpm-v" in store and "qwen" in store:
    (Xm,y),(Xq,_)=store["minicpm-v"],store["qwen"]
    for kind in ("logreg","centroid"):
        cm=caught(oof(Xm,y,kind,1729),y); cq=caught(oof(Xq,y,kind,1729),y)
        sp=y==1
        bq=int(((~cm[sp])&cq[sp]).sum())   # qwen catches, minicpm misses
        bm=int((cm[sp]&(~cq[sp])).sum())   # minicpm catches, qwen misses
        p=exact_p(bq,bm)
        print(f"  {kind:8}: minicpm recall {cm[sp].mean():.2f} vs qwen {cq[sp].mean():.2f}   qwen-only={bq} minicpm-only={bm}   McNemar p={p:.3f}  ({'SIGNIFICANT' if p<0.05 else 'not significant'})")
