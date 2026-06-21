#!/usr/bin/env python3
"""Pass 1 of the JoyCaption A/B arm: caption the SAME sample's covered items with
JoyCaption (llama.cpp), caching to exp-redescribe-joycaption.json — the exact file
exp-redescribe-reembed.py --captioner joycaption reads. Then pass 2 (that script)
only embeds + CVs (no Ollama describe, since all are pre-cached).

Run with the SIDECAR STOPPED (free memory so the GPU holds). Each image runs in its
OWN llama-mtmd-cli process (GPU -ngl 99), so a Metal OOM on one image can't corrupt
the rest; on empty output it retries that image on CPU (-ngl 0).

Run: ROOST_VAULT=<v> python scripts/describe-joycaption.py
"""
import os, glob, re, json, random, subprocess
import honest_eval_lib as L

LM="/tmp/jc-gguf/llama-joycaption-beta-one-hf-llava-q4_k_m.gguf"
MM="/tmp/jc-gguf/llama-joycaption-beta-one-llava-mmproj-model-f16.gguf"
PROMPT="Describe what is happening in this image in two or three sentences."  # same as the other arms

def caption(cover, ngl):
    try:
        r=subprocess.run(["llama-mtmd-cli","-m",LM,"--mmproj",MM,"--image",cover,
                          "-p",PROMPT,"-n","150","--temp","0.3","-ngl",str(ngl)],
                         capture_output=True, text=True, timeout=300)
        return r.stdout.strip()
    except Exception:
        return ""

def main():
    V=os.environ["ROOST_VAULT"]; C=os.path.join(V,".roost","cache")
    labels,_=L.load_honest_labels(V)
    tcache=json.load(open(os.path.join(C,"embedding-cache.json")))
    info={}
    for p in glob.glob(V+"/Bookmarks/**/*.md",recursive=True):
        t=open(p,encoding="utf-8",errors="ignore").read()
        m=re.search(r"^roost_id:\s*(\w+):(\S+)",t,re.M)
        if m: info[f"{m.group(1)}:{m.group(2)}"]=os.path.join(os.path.dirname(p),f"{m.group(1)}-{m.group(2)}")
    def cover(iid):
        d=info.get(iid)
        if not d or not os.path.isdir(d): return None
        for nm in ("cover.jpg","video-poster.jpg","card-thumb.jpg","1.jpg","thumb.png"):
            fp=os.path.join(d,nm)
            if os.path.exists(fp): return fp
        return None
    # SAME sample as exp-redescribe-reembed.py (seed 1729, 162 Spicy + 300 non-Spicy)
    random.seed(1729)
    spicy=[i for i in labels if labels[i]=="Spicy" and i in tcache and i in info]
    nons=[i for i in labels if labels[i]!="Spicy" and i in tcache and i in info]; random.shuffle(nons)
    sample=spicy+nons[:300]
    nvpath=os.path.join(C,"exp-redescribe-joycaption.json")
    nv=json.load(open(nvpath)) if os.path.exists(nvpath) else {}
    todo=[i for i in sample if cover(i) and i not in nv]
    print(f"JoyCaption-describing {len(todo)} covered items (GPU per-image, CPU fallback)...")
    gpu_fail=0
    for n,iid in enumerate(todo):
        c=cover(iid)
        cap=caption(c,99)
        if not cap:
            gpu_fail+=1; cap=caption(c,0)          # CPU fallback on GPU OOM/empty
        nv[iid]=cap
        if n%10==0:
            json.dump(nv,open(nvpath,"w")); print(f"  {n}/{len(todo)}  ({'OK' if cap else 'EMPTY'})  gpu_fallbacks={gpu_fail}")
    json.dump(nv,open(nvpath,"w"))
    ok=sum(1 for i in sample if nv.get(i))
    print(f"done. captioned {ok}/{len(sample)}  (CPU fallbacks: {gpu_fail})")

if __name__=="__main__": main()
