#!/usr/bin/env python3
"""Spike: validate the Marqo explicit-content image classifier against Roost's human Spicy labels.

Independent of the (refusing) LLM text pipeline — classifies the cover image directly,
so it's the censorship-resistant signal for the Spicy facet. Measures recall on the human
`collection: Spicy` items + FP rate on a non-Spicy sample (no cloud judge needed).

Run: ROOST_VAULT=<vault> python scripts/spike-uncensored-classifier.py [--threshold 0.75]
"""
import argparse, glob, os, re, sys, random
from pathlib import Path

import honest_eval_lib as L

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
import torch
from PIL import Image
import timm
from timm.data import resolve_data_config, create_transform

DEVICE = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
random.seed(1729)


def load_model():
    m = timm.create_model("hf_hub:Marqo/nsfw-image-detection-384", pretrained=True).eval().to(DEVICE)
    tf = create_transform(**resolve_data_config({}, model=m))
    return m, tf


def score(model, tf, path):
    try:
        x = tf(Image.open(path).convert("RGB")).unsqueeze(0).to(DEVICE)
        with torch.no_grad():
            return float(model(x).softmax(-1)[0][0])  # label_names=['NSFW','SFW'] → idx 0 = NSFW
    except Exception:
        return 0.0


def covers(folder: Path):
    out = []
    for name in ("cover.jpg", "video-poster.jpg", "card-thumb.jpg", "card.png", "thumb.png"):
        p = folder / name
        if p.exists():
            out.append(p)
    for i in range(1, 12):
        p = folder / f"{i}.jpg"
        if p.exists():
            out.append(p)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threshold", type=float, default=0.75)
    ap.add_argument("--neg-sample", type=int, default=300)
    args = ap.parse_args()
    vault = Path(os.environ["ROOST_VAULT"])

    labels, _ = L.load_honest_labels(str(vault))           # id -> human collection (GT)
    spicy_ids = {i for i, c in labels.items() if c == "Spicy"}
    other_ids = [i for i, c in labels.items() if c != "Spicy"]
    random.shuffle(other_ids)
    neg_ids = set(other_ids[: args.neg_sample])

    # id -> note dir (one vault pass)
    note_dir, plat = {}, {}
    for p in glob.glob(str(vault / "Bookmarks" / "**" / "*.md"), recursive=True):
        t = open(p, encoding="utf-8", errors="ignore").read()
        m = re.search(r"^roost_id:\s*(\w+):(\S+)", t, re.M)
        if m:
            iid = f"{m.group(1)}:{m.group(2)}"
            note_dir[iid] = Path(p).parent
            plat[iid] = m.group(1)

    print(f"loading Marqo uncensored-content model on {DEVICE} …", file=sys.stderr)
    model, tf = load_model()

    def folder_for(iid):
        if iid not in note_dir:
            return None
        num = iid.split(":", 1)[1]
        f = note_dir[iid] / f"{plat[iid]}-{num}"
        return f if f.exists() else None

    def max_score(iid):
        f = folder_for(iid)
        imgs = covers(f) if f else []
        return max((score(model, tf, str(p)) for p in imgs), default=None)

    spicy = [(i, max_score(i)) for i in spicy_ids]
    spicy = [(i, s) for i, s in spicy if s is not None]
    negs = [(i, max_score(i)) for i in neg_ids]
    negs = [(i, s) for i, s in negs if s is not None]

    print(f"\nSpicy items with a cover image: {len(spicy)} / {len(spicy_ids)}")
    print(f"Non-Spicy sample with a cover:  {len(negs)}")
    print(f"\n{'threshold':>10}{'recall':>9}{'FPrate':>9}{'precision*':>12}")
    for t in (0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9):
        tp = sum(1 for _, s in spicy if s >= t)
        fp = sum(1 for _, s in negs if s >= t)
        rec = tp / len(spicy) if spicy else 0
        fpr = fp / len(negs) if negs else 0
        # precision* extrapolated to the real base rate (Spicy ~ len(spicy_ids) of all labels)
        prec = tp / (tp + fp) if (tp + fp) else 0
        print(f"{t:>10.2f}{100*rec:>8.0f}%{100*fpr:>8.0f}%{100*prec:>11.0f}%")
    print("\n* precision here is at the SAMPLE ratio, not the true base rate (Spicy is rare).")
    print(f"Text-detector recall baseline to beat: ~73%. Ensemble = OR(image, text).")


if __name__ == "__main__":
    main()
