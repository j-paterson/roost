#!/usr/bin/env python3
"""D1 evaluation: does multi-keyframe video vision classify better than the single cover?

On TikTok video items with human labels, describe with qwen THREE ways and compare downstream
multi-class category accuracy (LogReg + centroid) + paired McNemar:
  A cover    — qwen on cover.jpg (single image)
  B frames   — qwen on 3 separate keyframes (beginning/middle/end) — tests multi-image
  C montage  — qwen on the 3 keyframes stitched into ONE image — temporal info, no image-bleed
Only the vision field differs across arms (summary/caption/title held constant). Reuses the same
A/B framework as the redescribe experiment. Run with sidecar UP (200-item scale fits memory).
"""
import os, glob, re, json, base64, random, subprocess, tempfile, urllib.request
from collections import Counter
import numpy as np, honest_eval_lib as L
from PIL import Image
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.metrics import accuracy_score
try:
    from scipy.stats import binomtest; ep=lambda b,c: binomtest(min(b,c),b+c,0.5).pvalue if b+c else 1.0
except Exception:
    from scipy.stats import binom_test; ep=lambda b,c: binom_test(min(b,c),b+c,0.5) if b+c else 1.0

OLLAMA="http://localhost:11434"; SIDECAR="http://localhost:11435"; MODEL="huihui_ai/qwen2.5-vl-abliterated:latest"
FF="/opt/homebrew/bin/ffmpeg"; FP="/opt/homebrew/bin/ffprobe"; N_NEG=250

def b64(p): return base64.b64encode(open(p,"rb").read()).decode()
def qwen(images, prompt):
    body=json.dumps({"model":MODEL,"prompt":prompt,"images":images,"stream":False,"options":{"num_ctx":8192}}).encode()
    try: return json.load(urllib.request.urlopen(urllib.request.Request(OLLAMA+"/api/generate",body,{"Content-Type":"application/json"}),timeout=240)).get("response","").strip()
    except Exception: return ""
def embed(t):
    body=json.dumps({"model":"x","input":[t]}).encode()
    v=json.load(urllib.request.urlopen(urllib.request.Request(SIDECAR+"/api/embed",body,{"Content-Type":"application/json"}),timeout=60))["embeddings"][0]
    v=np.asarray(v,float); return v/(np.linalg.norm(v) or 1)
def keyframes(mp4, tmp):
    try:
        dur=float(subprocess.run([FP,"-v","error","-show_entries","format=duration","-of","csv=p=0",mp4],capture_output=True,text=True,timeout=30).stdout.strip())
    except Exception: return []
    if not dur or dur<1: return []
    out=[]
    for i,frac in enumerate((0.1,0.5,0.9)):
        fp=os.path.join(tmp,f"f{i}.jpg")
        r=subprocess.run([FF,"-y","-ss",str(dur*frac),"-i",mp4,"-frames:v","1","-q:v","3",fp],capture_output=True,timeout=60)
        if os.path.exists(fp): out.append(fp)
    return out
def montage(frames, tmp):
    ims=[Image.open(f).convert("RGB") for f in frames]
    h=min(i.height for i in ims); ims=[i.resize((int(i.width*h/i.height),h)) for i in ims]
    W=sum(i.width for i in ims); m=Image.new("RGB",(W,h)); x=0
    for i in ims: m.paste(i,(x,0)); x+=i.width
    p=os.path.join(tmp,"montage.jpg"); m.save(p,quality=85); return p

def main():
    import argparse
    ap=argparse.ArgumentParser(); ap.add_argument("--phase",choices=["describe","embed","both"],default="both")
    PHASE=ap.parse_args().phase
    V=os.environ["ROOST_VAULT"]; C=os.path.join(V,".roost","cache")
    labels,_=L.load_honest_labels(V); tcache=json.load(open(C+"/embedding-cache.json"))
    info={}
    for p in glob.glob(V+"/Bookmarks/TikTok/**/*.md",recursive=True):
        t=open(p,encoding="utf-8",errors="ignore").read(); m=re.search(r"^roost_id:\s*(tiktok):(\S+)",t,re.M)
        if not m: continue
        d=os.path.join(os.path.dirname(p),f"tiktok-{m.group(2)}")
        fm=t.split('---')[1] if t.count('---')>=2 else ""; tit=re.search(r"^title:\s*(.*)$",fm,re.M); sub=re.search(r"^subtitle:\s*(.*)$",fm,re.M)
        info[f"tiktok:{m.group(2)}"]=dict(dir=d, mp4=os.path.join(d,"video.mp4"), cover=os.path.join(d,"cover.jpg"),
              title=(tit.group(1).strip().strip('"') if tit else ""), subtitle=(sub.group(1).strip().strip('"') if sub else ""))
    random.seed(1729)
    pool=[i for i in labels if i in tcache and i in info and os.path.exists(info[i]["mp4"]) and os.path.exists(info[i]["cover"])]
    random.shuffle(pool)
    cnt=Counter(labels[i] for i in pool[:600]); keep={c for c,k in cnt.items() if k>=6}
    sample=[i for i in pool if labels[i] in keep][:N_NEG]
    print(f"video items: {len(sample)}  categories: {sorted(set(labels[i] for i in sample))}")

    caches={a:(json.load(open(C+f"/exp-keyframe-{a}.json")) if os.path.exists(C+f"/exp-keyframe-{a}.json") else {}) for a in ("cover","frames","montage")}
    todo=[] if PHASE=="embed" else [i for i in sample if any(i not in caches[a] for a in caches)]
    if PHASE!="embed": print(f"describing {len(todo)} items x3 arms with qwen ...")
    for n,iid in enumerate(todo):
        it=info[iid]
        with tempfile.TemporaryDirectory() as tmp:
            if iid not in caches["cover"]:   caches["cover"][iid]=qwen([b64(it["cover"])],"Describe what is happening in this image in two or three sentences.")
            kf=keyframes(it["mp4"],tmp)
            if kf and iid not in caches["frames"]:  caches["frames"][iid]=qwen([b64(f) for f in kf],"These are frames from the beginning, middle, and end of a short video. Describe what happens in two or three sentences.")
            if kf and iid not in caches["montage"]: caches["montage"][iid]=qwen([b64(montage(kf,tmp))],"This is three frames (left=start, middle, right=end) of a short video. Describe what happens in two or three sentences.")
        if n%20==0:
            for a in caches: json.dump(caches[a],open(C+f"/exp-keyframe-{a}.json","w"))
            print(f"  {n}/{len(todo)}")
    for a in caches: json.dump(caches[a],open(C+f"/exp-keyframe-{a}.json","w"))
    if PHASE=="describe":
        print("=== describe phase complete — bring the sidecar UP, then run --phase embed ===")
        return

    def et(vis,i): it=info[i]; e=tcache[i]; return " ".join(x for x in [vis,e.get("summary"),e.get("category"),it["title"],it["subtitle"]] if x)
    y=np.array([labels[i] for i in sample]); cls=sorted(set(y)); yi=np.array([cls.index(c) for c in y]); skf=StratifiedKFold(5,shuffle=True,random_state=1729)
    arms={"OLD(empty)":lambda i:tcache[i].get("vision") or "","cover":lambda i:caches["cover"].get(i,""),"frames":lambda i:caches["frames"].get(i,""),"montage":lambda i:caches["montage"].get(i,"")}
    def lr_pred(X): return cross_val_predict(LogisticRegression(max_iter=1500,C=1.0,class_weight="balanced"),X,yi,cv=skf,n_jobs=-1)
    def ce_pred(X):
        pr=np.zeros(len(yi),int)
        for tr,te in skf.split(X,yi):
            cc=np.array([X[tr][yi[tr]==k].mean(0) for k in range(len(cls))]); cc/=np.linalg.norm(cc,axis=1,keepdims=True)+1e-9; pr[te]=(X[te]@cc.T).argmax(1)
        return pr
    print("\n=== multi-class top-1 accuracy (video items) ===")
    preds={}
    for nm,fn in arms.items():
        X=np.array([embed(et(fn(i),i)) for i in sample]); lp=lr_pred(X); cp=ce_pred(X); preds[nm]=(lp,cp)
        print(f"  {nm:11} LogReg {accuracy_score(yi,lp):.3f} | centroid {accuracy_score(yi,cp):.3f}")
    print("\n=== paired McNemar vs cover (does keyframe/montage beat single cover?) ===")
    for arm in ("frames","montage"):
        for k,idx in (("logreg",0),("centroid",1)):
            cc=(preds["cover"][idx]==yi); ac=(preds[arm][idx]==yi)
            b=int((~cc & ac).sum()); c=int((cc & ~ac).sum())   # b = arm-right cover-wrong
            print(f"  {arm} vs cover [{k}]: {arm}-only-correct={b} cover-only-correct={c}  McNemar p={ep(b,c):.3f}")
    print("\n=== per-category: cover-vision vs empty baseline (LogReg) — WHICH categories benefit? ===")
    lo=preds["OLD(empty)"][0]; lc=preds["cover"][0]
    out=[(c,ix,float(np.mean([lo[j]==yi[j] for j in ix])),float(np.mean([lc[j]==yi[j] for j in ix])))
         for c in sorted(set(y)) for ix in [[j for j in range(len(y)) if y[j]==c]] if len(ix)>=6]
    for c,ix,ao,ac in sorted(out,key=lambda r:-(r[3]-r[2])):
        print(f"  {c:18} n={len(ix):3}  empty {ao:.2f} -> cover {ac:.2f}  ({(ac-ao)*100:+.0f}pp)")

if __name__=="__main__": main()
