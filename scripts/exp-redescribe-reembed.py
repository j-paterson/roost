#!/usr/bin/env python3
"""Controlled A/B — does re-describing items with a non-refusing captioner improve
Spicy classification?

Holds everything constant except the `vision` field of the embed input
([vision, summary, category, title, subtitle].join). Re-embeds BOTH arms via the
production sidecar (so only vision differs), fits a FRESH Spicy detector per arm via
5-fold CV (no old centroids reused), and compares AUROC + recall. Both classes are
re-described so the detector can't just learn "richer vision = Spicy".

Run: ROOST_VAULT=<v> python scripts/exp-redescribe-reembed.py --captioner minicpm-v --n-neg 300
"""
import os, glob, re, json, base64, random, urllib.request, argparse
import numpy as np
import honest_eval_lib as L
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.metrics import roc_auc_score

OLLAMA="http://localhost:11434"; SIDECAR="http://localhost:11435"
VPROMPT="Describe what is happening in this image in two or three sentences."

def ollama_vision(model, imgpath):
    b64=base64.b64encode(open(imgpath,"rb").read()).decode()
    body=json.dumps({"model":model,"prompt":VPROMPT,"images":[b64],"stream":False,
                     "options":{"temperature":0,"num_predict":150}}).encode()
    req=urllib.request.Request(OLLAMA+"/api/generate",body,{"Content-Type":"application/json"})
    try: return json.load(urllib.request.urlopen(req,timeout=180)).get("response","").strip()
    except Exception: return ""

def sidecar_embed(text):
    body=json.dumps({"model":"x","input":[text]}).encode()
    req=urllib.request.Request(SIDECAR+"/api/embed",body,{"Content-Type":"application/json"})
    v=json.load(urllib.request.urlopen(req,timeout=60))["embeddings"][0]
    return np.asarray(v,np.float64)

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--captioner",default="minicpm-v")
    ap.add_argument("--n-neg",type=int,default=300)
    args=ap.parse_args()
    V=os.environ["ROOST_VAULT"]; C=os.path.join(V,".roost","cache")
    labels,_=L.load_honest_labels(V)
    tcache=json.load(open(os.path.join(C,"embedding-cache.json")))
    info={}
    for p in glob.glob(V+"/Bookmarks/**/*.md",recursive=True):
        t=open(p,encoding="utf-8",errors="ignore").read()
        m=re.search(r"^roost_id:\s*(\w+):(\S+)",t,re.M)
        if not m: continue
        iid=f"{m.group(1)}:{m.group(2)}"
        fm=t.split('---')[1] if t.count('---')>=2 else ""
        tit=re.search(r"^title:\s*(.*)$",fm,re.M); sub=re.search(r"^subtitle:\s*(.*)$",fm,re.M)
        info[iid]=dict(dir=os.path.join(os.path.dirname(p),f"{m.group(1)}-{m.group(2)}"),
                       title=(tit.group(1).strip().strip('"') if tit else ""),
                       subtitle=(sub.group(1).strip().strip('"') if sub else ""))
    def cover(iid):
        d=info.get(iid,{}).get("dir")
        if not d or not os.path.isdir(d): return None
        for nm in ("cover.jpg","video-poster.jpg","card-thumb.jpg","1.jpg","thumb.png"):
            fp=os.path.join(d,nm)
            if os.path.exists(fp): return fp
        return None
    random.seed(1729)
    spicy=[i for i in labels if labels[i]=="Spicy" and i in tcache and i in info]
    nons=[i for i in labels if labels[i]!="Spicy" and i in tcache and i in info]; random.shuffle(nons)
    sample=spicy+nons[:args.n_neg]
    ncov=sum(1 for i in sample if cover(i))
    print(f"sample: {len(spicy)} Spicy + {min(args.n_neg,len(nons))} non-Spicy = {len(sample)}  ({ncov} have a cover)")

    nvpath=os.path.join(C,f"exp-redescribe-{args.captioner.replace(':','_').replace('/','_')}.json")
    nv=json.load(open(nvpath)) if os.path.exists(nvpath) else {}
    todo=[i for i in sample if cover(i) and i not in nv]
    print(f"re-describing {len(todo)} covered items with {args.captioner} ...")
    for n,iid in enumerate(todo):
        nv[iid]=ollama_vision(args.captioner, cover(iid))
        if n%25==0:
            json.dump(nv,open(nvpath,"w")); print(f"  described {n}/{len(todo)}")
    json.dump(nv,open(nvpath,"w"))

    def etext(vision, iid):
        e=tcache[iid]; it=info[iid]
        parts=[vision, e.get("summary"), e.get("category"), it["title"], it["subtitle"]]
        return " ".join(p for p in parts if p)
    Xold=[];Xnew=[];y=[]
    for n,iid in enumerate(sample):
        oldv=tcache[iid].get("vision") or ""
        newv=nv.get(iid, oldv)          # uncovered items: unchanged in both arms
        oe=sidecar_embed(etext(oldv,iid)); ne=sidecar_embed(etext(newv,iid))
        oe=oe/(np.linalg.norm(oe) or 1); ne=ne/(np.linalg.norm(ne) or 1)
        Xold.append(oe);Xnew.append(ne);y.append(1 if labels[iid]=="Spicy" else 0)
        if n%50==0: print(f"  embedding {n}/{len(sample)}")
    Xold=np.array(Xold);Xnew=np.array(Xnew);y=np.array(y)

    def cv_eval(X,y):
        oof=cross_val_predict(LogisticRegression(max_iter=1500,C=1,class_weight="balanced"),
                              X,y,cv=StratifiedKFold(5,shuffle=True,random_state=1729),
                              method="predict_proba",n_jobs=-1)[:,1]
        auroc=roc_auc_score(y,oof)
        thr=np.quantile(oof[y==0],0.90)         # operating point: 10% FPR on negatives
        rec=float((oof[y==1]>=thr).mean())
        return auroc, rec
    ao,ro=cv_eval(Xold,y); an,rn=cv_eval(Xnew,y)
    print("\n=== RESULT — fresh Spicy detector per arm, 5-fold CV (only vision differs) ===")
    print(f"  re-described (covered): {ncov}/{len(sample)} items")
    print(f"  OLD vision        : AUROC {ao:.3f} | recall@10%FPR {ro:.3f}")
    print(f"  NEW ({args.captioner:<12}): AUROC {an:.3f} | recall@10%FPR {rn:.3f}")
    print(f"  DELTA             : AUROC {an-ao:+.3f} | recall {rn-ro:+.3f}")

    # ── Persist EVERYTHING separately + tracked, so later comparisons (new detectors,
    #    metrics, captioner ensembles) need no re-describe / re-embed. ──
    tag=args.captioner.replace(':','_').replace('/','_')
    D=os.path.join(C,"redescribe-exp"); os.makedirs(D,exist_ok=True)
    # per-item arrays: old + new embeddings, label, id, and BOTH vision texts
    np.savez_compressed(os.path.join(D,f"emb-{tag}.npz"),
                        Xold=Xold, Xnew=Xnew, y=y, ids=np.array(sample,dtype=object),
                        vision_new=np.array([nv.get(i,"") for i in sample],dtype=object),
                        vision_old=np.array([tcache[i].get("vision") or "" for i in sample],dtype=object))
    json.dump({i:nv.get(i,"") for i in sample}, open(os.path.join(D,f"descriptions-{tag}.json"),"w"))
    result=dict(captioner=args.captioner,tag=tag,n=len(sample),ncov=ncov,seed=1729,n_neg=args.n_neg,
                prompt=VPROMPT,auroc_old=ao,auroc_new=an,recall_old=ro,recall_new=rn,
                delta_auroc=an-ao,delta_recall=rn-ro,
                files=dict(embeddings=f"emb-{tag}.npz",descriptions=f"descriptions-{tag}.json"))
    json.dump(result, open(os.path.join(D,f"result-{tag}.json"),"w"), indent=2)
    mpath=os.path.join(D,"manifest.json")
    man=json.load(open(mpath)) if os.path.exists(mpath) else {"experiment":"redescribe-reembed Spicy A/B","runs":{}}
    man["runs"][tag]=result
    json.dump(man, open(mpath,"w"), indent=2)
    print(f"  persisted → {D}/  (emb-{tag}.npz, descriptions-{tag}.json, result-{tag}.json, manifest.json)")

if __name__=="__main__": main()
