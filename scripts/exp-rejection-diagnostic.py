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

# ── Phase 3 helpers (stacked-meta confidence, reuse acceptance-gate-stacking math) ──

def _sfmax(z):
    e=np.exp(z-z.max()); return e/e.sum()

def _l2n(v):
    n=float(np.linalg.norm(v)); return v/(n if n else 1.0)

def _load_head(path):
    with open(path) as fh: return json.load(fh)

# CANONICAL SOURCE: acceptance-gate-stacking.py forward_stacked / forward_single.
# These functions extend those by also returning the max-softmax confidence (the
# gate functions only return the category string and their return type is not changed
# here to avoid touching fair-baseline-check.py).  Any math change in the gate must
# be mirrored here; the divergence guard below will catch regressions at run-time.
def _fwd_stacked_score(th,tv,tm,vt,vv):
    """Returns (pred_class: str, meta_max_softmax: float). Math mirrors acceptance-gate-stacking.py forward_stacked."""
    Wt=np.asarray(th["W"],np.float64); bt=np.asarray(th["b"],np.float64)
    Wv=np.asarray(tv["W"],np.float64); bv=np.asarray(tv["b"],np.float64)
    Wm=np.asarray(tm["W"],np.float64); bm=np.asarray(tm["b"],np.float64)
    pt=_sfmax(Wt@_l2n(vt.astype(np.float64))+bt)
    pv=_sfmax(Wv@_l2n(vv.astype(np.float64))+bv)
    pm=_sfmax(Wm@np.concatenate([pt,pv])+bm)
    return tm["classes"][int(pm.argmax())], float(pm.max())

def _fwd_single_score(hs,vv):
    """Returns (pred_class: str, max_softmax: float). Math mirrors acceptance-gate-stacking.py forward_single."""
    W=np.asarray(hs["W"],np.float64); b=np.asarray(hs["b"],np.float64)
    p=_sfmax(W@_l2n(vv.astype(np.float64))+b)
    return hs["classes"][int(p.argmax())], float(p.max())

def _pick_tau(score,correct,target=0.90):
    """Lowest τ whose precision-on-accepted >= target. Returns (tau, prec, cov) or None."""
    best=None
    for tau in np.unique(score)[::-1]:          # descending: high→low τ
        mask=score>=tau
        if mask.sum()==0: continue
        prec=float(correct[mask].mean())
        cov=float(mask.mean())
        if prec>=target:
            best=(float(tau),prec,cov)           # keep updating → lowest valid τ
    return best

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

    # ── Phase 3 — Stacked-meta confidence calibration (τ_head, τ_centroid) ────
    phase3={}
    cdir=os.path.join(V,".roost","cache")
    heads_ok=all(os.path.exists(os.path.join(cdir,h)) for h in
                 ["classifier-head.json","classifier-head-text.json",
                  "classifier-head-vision.json","meta-head.json"])
    print("\n── Phase 3: stacked-meta confidence calibration (τ_head, τ_centroid) ──")
    if not heads_ok:
        print("  SKIPPED — one or more head JSONs missing")
        print("  Conservative fallbacks: τ_head=0.55  τ_centroid=0.50  (un-calibrated)")
        phase3={"skipped":True,"tau_head":0.55,"tau_centroid":0.50}
    else:
        hs =_load_head(os.path.join(cdir,"classifier-head.json"))
        th_ =_load_head(os.path.join(cdir,"classifier-head-text.json"))
        tv_ =_load_head(os.path.join(cdir,"classifier-head-vision.json"))
        tm_ =_load_head(os.path.join(cdir,"meta-head.json"))
        meta_classes=tm_["classes"]
        # Guard: single + meta heads must share the same taxonomy or AUROC for
        # the single-head sanity check is meaningless.
        assert set(hs["classes"])==set(meta_classes), (
            f"single-head classes != meta classes — "
            f"single={sorted(hs['classes'])}  meta={sorted(meta_classes)}"
        )

        # Load both embedding caches (text + vision)
        vcache=L.load_cache(bin_path=os.path.join(cdir,"embedding-vectors.bin"))
        tcache=L.load_cache(bin_path=os.path.join(cdir,"embedding-vectors-text.bin"))
        labels3,_=L.load_honest_labels(V)

        # Build per-item arrays with both embeddings
        ids3,cats3,vvecs3,tvecs3=[],[],[],[]
        for iid,cat in labels3.items():
            if cat in DROP: continue
            if cat not in meta_classes: continue
            vv=vcache.get(iid); vt=tcache.get(iid)
            if vv is None or vt is None: continue
            vv=np.asarray(vv,np.float64); vt=np.asarray(vt,np.float64)
            nv=np.linalg.norm(vv); nt=np.linalg.norm(vt)
            if nv==0 or nt==0 or not np.isfinite(vv).all() or not np.isfinite(vt).all(): continue
            ids3.append(iid); cats3.append(cat); vvecs3.append(vv/nv); tvecs3.append(vt/nt)

        n3=len(ids3)
        print(f"  items with both embeddings + labels: {n3}")
        Xv3=np.array(vvecs3)

        # ── Divergence guard: spot-check first item against canonical gate ────
        import importlib.util as _ilu
        _gp=os.path.join(os.path.dirname(os.path.abspath(__file__)),"acceptance-gate-stacking.py")
        _gs=_ilu.spec_from_file_location("_gate",_gp); _gm=_ilu.module_from_spec(_gs); _gs.loader.exec_module(_gm)
        _sv,_st=vvecs3[0],tvecs3[0]
        _sp_stacked,_=_fwd_stacked_score(th_,tv_,tm_,_st,_sv)
        _gp_stacked=_gm.forward_stacked(th_,tv_,tm_,_st,_sv)
        assert _sp_stacked==_gp_stacked,(
            f"DIVERGENCE _fwd_stacked_score→{_sp_stacked!r} != gate forward_stacked→{_gp_stacked!r}; "
            "sync with acceptance-gate-stacking.py forward_stacked"
        )
        _sp_single,_=_fwd_single_score(hs,_sv)
        _gp_single=_gm.forward_single(hs,_sv)
        assert _sp_single==_gp_single,(
            f"DIVERGENCE _fwd_single_score→{_sp_single!r} != gate forward_single→{_gp_single!r}; "
            "sync with acceptance-gate-stacking.py forward_single"
        )
        print(f"  divergence-guard PASS: item[0]={ids3[0]} stacked={_sp_stacked!r} single={_sp_single!r}")

        # Forward passes
        msp_meta=np.zeros(n3); msp_single=np.zeros(n3)
        pred_meta_i=np.zeros(n3,int); pred_single_i=np.zeros(n3,int)
        for i,(vv,vt) in enumerate(zip(vvecs3,tvecs3)):
            pm,mm=_fwd_stacked_score(th_,tv_,tm_,vt,vv)
            ps,ms=_fwd_single_score(hs,vv)
            pred_meta_i[i]=meta_classes.index(pm)
            msp_meta[i]=mm
            pred_single_i[i]=meta_classes.index(ps) if ps in meta_classes else -1
            msp_single[i]=ms

        gt3=np.array([meta_classes.index(c) for c in cats3])
        corr_meta=(pred_meta_i==gt3).astype(int)
        corr_single=(pred_single_i==gt3).astype(int)

        # Cosine-centroid top sim (vision embeddings; production centroids over all labeled items)
        cats3_arr=np.array(cats3)
        cents3=np.array([
            _l2n(Xv3[cats3_arr==cl].mean(0)) if (cats3_arr==cl).sum()>0 else np.zeros(Xv3.shape[1])
            for cl in meta_classes
        ])
        cos_sim3=(Xv3@cents3.T).max(1)

        # AUROC sanity checks
        auroc_meta=roc_auc_score(corr_meta,msp_meta)
        auroc_single_h=roc_auc_score(corr_single,msp_single)
        auroc_cos3=roc_auc_score(corr_meta,cos_sim3)
        print(f"  AUROC single-head max-softmax: {auroc_single_h:.3f}  (sanity ≈0.76)")
        print(f"  AUROC meta max-softmax:        {auroc_meta:.3f}")
        print(f"  AUROC cosine-centroid:         {auroc_cos3:.3f}  (sanity ≈0.613)")

        # Calibrate τ_head
        r_head=_pick_tau(msp_meta,corr_meta,target=0.90)
        if r_head:
            tau_h,prec_h,cov_h=r_head
            print(f"  τ_head={tau_h:.4f}  (prec={prec_h:.3f}  cov={cov_h:.3f})")
        else:
            tau_h,prec_h,cov_h=0.55,float('nan'),float('nan')
            print("  τ_head=FALLBACK 0.55  (no threshold achieves prec≥0.90)")

        # Calibrate τ_centroid
        r_cos=_pick_tau(cos_sim3,corr_meta,target=0.90)
        if r_cos:
            tau_c,prec_c,cov_c=r_cos
            print(f"  τ_centroid={tau_c:.4f}  (prec={prec_c:.3f}  cov={cov_c:.3f})")
        else:
            tau_c,prec_c,cov_c=0.50,float('nan'),float('nan')
            print("  τ_centroid=FALLBACK 0.50  (no threshold achieves prec≥0.90)")

        phase3={"n":n3,"auroc_single_msp":auroc_single_h,"auroc_meta_msp":auroc_meta,
                "auroc_cosine":auroc_cos3,
                "tau_head":tau_h,"tau_head_prec":prec_h,"tau_head_cov":cov_h,
                "tau_centroid":tau_c,"tau_centroid_prec":prec_c,"tau_centroid_cov":cov_c}

    os.makedirs(os.path.join(V,".roost","cache","redescribe-exp"),exist_ok=True)
    json.dump({"dim95":dim95,"participation_ratio":pr,"intra":intra,"inter":inter,"silhouette":sil,
               "lr_C1":acc1,"lr_tunedC":accT,"top1":float(correct.mean()),
               "phase1":{nm:float(roc_auc_score(correct,s)) for nm,s in [("msp",msp),("cosine",cos),("maha",mah),("rmd",rmd)]},
               "phase2_mean_ood_auroc":float(np.mean([a for _,a,_ in res])),
               "phase2":{h:a for h,a,_ in res},"phase3":phase3},
              open(os.path.join(V,".roost","cache","redescribe-exp","rejection-diagnostic.json"),"w"),indent=2)

if __name__=="__main__": main()
