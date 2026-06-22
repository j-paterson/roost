#!/usr/bin/env python3
"""gemma4 vs qwen-abliterated as a GENERAL vision describer.

On NON-Spicy covered items (across categories), re-describe with gemma4 and qwen, re-embed,
and compare MULTI-CLASS category classification (LogReg + nearest-centroid top-1). Decides
whether qwen can replace gemma globally without hurting normal categories — the gate for
collapsing the uncensored special-case into one vision model.

qwen descriptions are reused from the redescribe experiment cache; gemma is described fresh.
Run with the sidecar UP. Run: ROOST_VAULT=<v> python scripts/exp-gemma-vs-qwen-general.py
"""
import os, glob, re, json, base64, random, subprocess, urllib.request
from collections import Counter
import numpy as np
import honest_eval_lib as L
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold
from sklearn.metrics import accuracy_score

OLLAMA="http://localhost:11434"; SIDECAR="http://localhost:11435"
VPROMPT="Describe what is happening in this image in two or three sentences."

def ollama_vision(model, imgpath):
    b64=base64.b64encode(open(imgpath,"rb").read()).decode()
    # num_ctx (NOT num_predict) — gemma4:e4b returns EMPTY with num_predict set; this matches the pipeline.
    body=json.dumps({"model":model,"prompt":VPROMPT,"images":[b64],"stream":False,
                     "options":{"num_ctx":2048}}).encode()
    req=urllib.request.Request(OLLAMA+"/api/generate",body,{"Content-Type":"application/json"})
    try: return json.load(urllib.request.urlopen(req,timeout=180)).get("response","").strip()
    except Exception: return ""

def sidecar_embed(text):
    body=json.dumps({"model":"x","input":[text]}).encode()
    req=urllib.request.Request(SIDECAR+"/api/embed",body,{"Content-Type":"application/json"})
    v=json.load(urllib.request.urlopen(req,timeout=60))["embeddings"][0]
    v=np.asarray(v,np.float64); return v/(np.linalg.norm(v) or 1)

def main():
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
    # SAME non-Spicy sample as the redescribe experiment (so qwen cache lines up)
    random.seed(1729)
    nons=[i for i in labels if labels[i]!="Spicy" and i in tcache and i in info]; random.shuffle(nons)
    sample=[i for i in nons[:300] if cover(i)]
    print(f"non-Spicy covered items: {len(sample)}")

    qcache=json.load(open(os.path.join(C,"exp-redescribe-huihui_ai_qwen2.5-vl-abliterated_latest.json")))
    gpath=os.path.join(C,"exp-general-gemma.json")
    gcache=json.load(open(gpath)) if os.path.exists(gpath) else {}
    todo=[i for i in sample if i not in gcache]
    print(f"gemma4-describing {len(todo)} items ...")
    for n,iid in enumerate(todo):
        gcache[iid]=ollama_vision("gemma4:e4b", cover(iid))
        if n%25==0: json.dump(gcache,open(gpath,"w")); print(f"  {n}/{len(todo)}")
    json.dump(gcache,open(gpath,"w"))
    g_empty=sum(1 for i in sample if not gcache.get(i))
    print(f"  gemma empty/refused on {g_empty}/{len(sample)} non-Spicy items")
    subprocess.run(["ollama","stop","gemma4:e4b"],capture_output=True)  # free 9.6GB before embedding

    # keep only categories with >=6 members for a stable multi-class CV
    cnt=Counter(labels[i] for i in sample); keep={c for c,k in cnt.items() if k>=6}
    sample=[i for i in sample if labels[i] in keep]
    print(f"multi-class over {len(keep)} categories, {len(sample)} items: {sorted(keep)}")

    def etext(vision, iid):
        e=tcache[iid]; it=info[iid]
        return " ".join(p for p in [vision, e.get("summary"), e.get("category"), it["title"], it["subtitle"]] if p)
    arms={
      "OLD (cached/empty)": lambda i: tcache[i].get("vision") or "",
      "gemma4":             lambda i: gcache.get(i,""),
      "qwen-abliterated":   lambda i: qcache.get(i,""),
    }
    y=np.array([labels[i] for i in sample])
    classes=sorted(set(y)); yi=np.array([classes.index(c) for c in y])
    def logreg_acc(X):
        from sklearn.model_selection import cross_val_predict
        p=cross_val_predict(LogisticRegression(max_iter=1500,C=1,class_weight="balanced"),
                            X,yi,cv=StratifiedKFold(5,shuffle=True,random_state=1729),n_jobs=-1)
        return accuracy_score(yi,p)
    def centroid_acc(X):
        pred=np.zeros(len(yi),int)
        for tr,te in StratifiedKFold(5,shuffle=True,random_state=1729).split(X,yi):
            cents=np.array([X[tr][yi[tr]==k].mean(0) for k in range(len(classes))])
            cents/=np.linalg.norm(cents,axis=1,keepdims=True)+1e-9
            pred[te]=(X[te]@cents.T).argmax(1)
        return accuracy_score(yi,pred)
    print("\n=== GENERAL describer: multi-class top-1 accuracy (non-Spicy categories) ===")
    res={}
    for name,fn in arms.items():
        X=np.array([sidecar_embed(etext(fn(i),i)) for i in sample])
        la,ca=logreg_acc(X),centroid_acc(X)
        res[name]=dict(logreg=la,centroid=ca)
        print(f"  {name:22} LogReg {la:.3f} | centroid {ca:.3f}")
    D=os.path.join(C,"redescribe-exp"); os.makedirs(D,exist_ok=True)
    json.dump(dict(n=len(sample),categories=sorted(keep),gemma_empty=g_empty,results=res),
              open(os.path.join(D,"general-gemma-vs-qwen.json"),"w"),indent=2)
    print(f"  persisted → {D}/general-gemma-vs-qwen.json")

if __name__=="__main__": main()
