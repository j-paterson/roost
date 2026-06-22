#!/usr/bin/env python3
"""Open-set rejection diagnostic — is our ~random rejection a METHOD problem (we used max-softmax,
the known-weak baseline) or a GEOMETRY problem (collapsed embeddings nothing can exploit)?

Phase 0  geometry: effective dim (PCA), intra- vs inter-class cosine, silhouette; tuned-C LogReg sanity.
Phase 1  selective classification: AUROC at separating the classifier's OWN correct vs wrong
         predictions, for max-softmax vs cosine-centroid vs Mahalanobis (Ledoit-Wolf) vs RelMaha.
Phase 2  OOD: leave-one-category-out — does Mahalanobis flag held-out-category items as not-belonging?

Reads cached embeddings + honest labels. Run: ROOST_VAULT=<v> python scripts/exp-rejection-diagnostic.py
"""
import os, json, numpy as np
import honest_eval_lib as L
from sklearn.linear_model import LogisticRegression, LogisticRegressionCV
from sklearn.model_selection import StratifiedKFold
from sklearn.metrics import roc_auc_score, accuracy_score, silhouette_score
from sklearn.decomposition import PCA
from sklearn.covariance import LedoitWolf

SEED=1729; DROP={"Content Creation"}

def load_xy(vault):
    cache=L.load_cache(bin_path=os.path.join(vault,".roost","cache","embedding-vectors.bin"))
    labels,_=L.load_honest_labels(vault)
    X,y=[],[]
    for iid,c in labels.items():
        if c in DROP: continue
        v=cache.get(iid)
        if v is None: continue
        v=np.asarray(v,np.float64); n=np.linalg.norm(v)
        if n==0 or not np.isfinite(v).all(): continue
        X.append(v/n); y.append(c)
    return np.array(X), np.array(y)

def maha_scores(Xtr,yi_tr,Xte,classes):
    """nearest-centroid Mahalanobis (Ledoit-Wolf shared cov) min-distance to any centroid, + the
    relative-Mahalanobis (background-subtracted) variant. Returns (min_maha_dist, rel_maha_dist)."""
    cents=np.array([Xtr[yi_tr==k].mean(0) for k in range(len(classes))])
    centered=np.vstack([Xtr[yi_tr==k]-cents[k] for k in range(len(classes))])
    VI=LedoitWolf().fit(centered).precision_
    def md(Z,c): diff=Z-c; return np.einsum('ij,jk,ik->i',diff,VI,diff)
    D=np.stack([md(Xte,cents[k]) for k in range(len(classes))],1)   # (n, K)
    c0=Xtr.mean(0); bg=md(Xte,c0)                                    # background gaussian
    return D.min(1), (D.min(1)-bg)

def main():
    V=os.environ["ROOST_VAULT"]
    X,y=load_xy(V); classes=sorted(set(y)); yi=np.array([classes.index(c) for c in y])
    print(f"items={len(y)}  dim={X.shape[1]}  classes={len(classes)}")

    # ── Phase 0 — geometry ────────────────────────────────────────────────────
    evr=PCA().fit(X).explained_variance_ratio_
    dim95=int(np.searchsorted(np.cumsum(evr),0.95))+1
    pr=(evr.sum()**2)/(evr**2).sum()
    cents={c:(lambda m: m/np.linalg.norm(m))(X[y==c].mean(0)) for c in classes}
    intra=float(np.mean([X[i]@cents[y[i]] for i in range(len(y))]))
    cm=np.array([cents[c] for c in classes]); inter=float((cm@cm.T)[np.triu_indices(len(classes),1)].mean())
    sil=float(silhouette_score(X,y,metric="cosine",sample_size=min(2500,len(y)),random_state=SEED))
    print("\n── Phase 0: geometry ──")
    print(f"  effective dim: dim@95%var={dim95}/{X.shape[1]}   participation_ratio={pr:.0f}")
    print(f"  intra-class cos {intra:.3f} | inter-centroid cos {inter:.3f} | margin {intra-inter:+.3f}")
    print(f"  silhouette(cosine) {sil:.3f}   (>0.1 real structure, ~0 mushy)")
    # tuned-C LogReg sanity
    skf=StratifiedKFold(5,shuffle=True,random_state=SEED)
    from sklearn.model_selection import cross_val_predict
    acc1=accuracy_score(yi,cross_val_predict(LogisticRegression(max_iter=1500,C=1.0,class_weight='balanced'),X,yi,cv=skf,n_jobs=-1))
    lrcv=LogisticRegressionCV(Cs=[.001,.01,.1,.5,1.0],cv=5,max_iter=1500,class_weight='balanced',n_jobs=-1).fit(X,yi)
    accT=accuracy_score(yi,cross_val_predict(LogisticRegression(max_iter=1500,C=float(np.median(lrcv.C_)),class_weight='balanced'),X,yi,cv=skf,n_jobs=-1))
    print(f"  LogReg top-1: C=1.0 {acc1:.3f}  |  tuned C≈{np.median(lrcv.C_):.3g} {accT:.3f}")

    # ── Phase 1 — selective classification (detect own errors) ────────────────
    msp=np.zeros(len(y)); cos=np.zeros(len(y)); mah=np.zeros(len(y)); rmd=np.zeros(len(y)); pred=np.zeros(len(y),int)
    for tr,te in skf.split(X,yi):
        clf=LogisticRegression(max_iter=1500,C=0.1,class_weight='balanced').fit(X[tr],yi[tr])
        P=clf.predict_proba(X[te]); pred[te]=P.argmax(1); msp[te]=P.max(1)
        cn=cm=np.array([X[tr][yi[tr]==k].mean(0) for k in range(len(classes))]); cn=cm/np.linalg.norm(cm,axis=1,keepdims=True)
        cos[te]=(X[te]@cn.T).max(1)
        dmin,drel=maha_scores(X[tr],yi[tr],X[te],classes); mah[te]=-dmin; rmd[te]=-drel
    correct=(pred==yi).astype(int)
    print("\n── Phase 1: AUROC separating CORRECT vs WRONG predictions (higher=better selector) ──")
    print(f"  closed-set top-1 acc: {correct.mean():.3f}")
    for nm,s in [("max-softmax (baseline)",msp),("cosine-centroid",cos),("Mahalanobis",mah),("RelMahalanobis",rmd)]:
        print(f"  {nm:24} AUROC {roc_auc_score(correct,s):.3f}")

    # ── Phase 2 — leave-one-category-out OOD ──────────────────────────────────
    print("\n── Phase 2: leave-one-category-out OOD (Mahalanobis dist, AUROC in-vs-out) ──")
    rng=np.random.RandomState(SEED); res=[]
    for held in classes:
        inm=y!=held; outm=y==held
        if outm.sum()<8: continue
        Xin,yin=X[inm],y[inm]; cls=sorted(set(yin)); yin_i=np.array([cls.index(c) for c in yin])
        nood=int(outm.sum())
        # NO LEAKAGE: hold the in-distribution test sample OUT of the centroid/covariance fit
        # (scoring an in-sample subset biases its distance down and inflates AUROC by ~+0.06).
        perm=rng.permutation(len(Xin)); test=perm[:nood]; fit=perm[nood:]
        dmin_id,_=maha_scores(Xin[fit],yin_i[fit],Xin[test],cls)
        dmin_oo,_=maha_scores(Xin[fit],yin_i[fit],X[outm],cls)
        lab=np.r_[np.zeros(len(dmin_id)),np.ones(len(dmin_oo))]; sc=np.r_[dmin_id,dmin_oo]
        res.append((held,float(roc_auc_score(lab,sc)),nood))
    for h,a,n in sorted(res,key=lambda x:-x[1]): print(f"  hold {h:18} AUROC {a:.3f}  (n_ood={n})")
    print(f"  MEAN OOD AUROC: {np.mean([a for _,a,_ in res]):.3f}")
    os.makedirs(os.path.join(V,".roost","cache","redescribe-exp"),exist_ok=True)
    json.dump({"dim95":dim95,"participation_ratio":pr,"intra":intra,"inter":inter,"silhouette":sil,
               "lr_C1":acc1,"lr_tunedC":accT,"top1":float(correct.mean()),
               "phase1":{nm:float(roc_auc_score(correct,s)) for nm,s in [("msp",msp),("cosine",cos),("maha",mah),("rmd",rmd)]},
               "phase2_mean_ood_auroc":float(np.mean([a for _,a,_ in res])),
               "phase2":{h:a for h,a,_ in res}},
              open(os.path.join(V,".roost","cache","redescribe-exp","rejection-diagnostic.json"),"w"),indent=2)

if __name__=="__main__": main()
