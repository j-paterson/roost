#!/usr/bin/env python3
"""Supplementary to acceptance-gate-stacking.py: report THREE top-1 numbers per
platform so the stacking benefit can be read cleanly:

  single   — classifier-head.json   (production single head; older representation,
                                      trained on the full 4220-item honest set)
  vision   — classifier-head-vision.json (the stacked system's vision base head;
                                      SAME qwen-cover representation as `stacked`)
  stacked  — text+vision+meta

`stacked vs single`  = the gate's criterion (vs what production runs today).
`stacked vs vision`  = the pure meta+text lift on an identical representation
                       (apples-to-apples, removes the train-set/representation confound).

Reuses acceptance-gate-stacking.py verbatim for embedding, caption + cover
construction, sampling, and forward passes — so numbers are comparable.

Run (sidecar UP):  ROOST_VAULT=<vault> python scripts/fair-baseline-check.py
"""
import importlib.util
import os
import sys
from pathlib import Path

import numpy as np

SD = os.path.dirname(os.path.abspath(__file__))


def _loadmod(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


G = _loadmod("gate", os.path.join(SD, "acceptance-gate-stacking.py"))


def main():
    vault = G.get_vault()
    c = G.cache_dir(vault)
    if not G.check_heads(c):
        sys.exit(1)
    single, text, vision, meta = G.load_all_heads(c)

    tk_cover_path = c / "exp-keyframe-cover.json"
    tw_cover_path = c / "exp-twitter-cover.json"
    import json
    tk_cover = json.load(open(tk_cover_path)) if tk_cover_path.exists() else {}
    tw_cover = json.load(open(tw_cover_path)) if tw_cover_path.exists() else {}

    plats = [
        ("tiktok", G.build_sample_tiktok, G.cap_tiktok, tk_cover),
        ("twitter", G.build_sample_twitter, G.cap_twitter, tw_cover),
    ]

    print("fair-baseline-check.py")
    print("=" * 60)
    for name, build, cap_fn, cover in plats:
        samp, labels, tcache, info = build(vault, 900, SD)
        n = len(samp)
        cs = cv = ck = 0
        for iid in samp:
            gt = labels[iid]
            cap = cap_fn(iid, tcache, info)
            vec_text = G.embed(cap)
            vec_vision = G.embed(G.cover_text(iid, cover, cap))
            if G.forward_single(single, vec_vision) == gt:
                cs += 1
            if G.forward_single(vision, vec_vision) == gt:
                cv += 1
            if G.forward_stacked(text, vision, meta, vec_text, vec_vision) == gt:
                ck += 1
        print(f"\n{name}  (n={n})")
        print(f"  single  (classifier-head.json)        : {cs/n*100:.1f}%")
        print(f"  vision  (classifier-head-vision.json) : {cv/n*100:.1f}%   [same rep as stacked]")
        print(f"  stacked (text+vision+meta)            : {ck/n*100:.1f}%")
        print(f"  stacked - single : {(ck-cs)/n*100:+.1f}pp   (gate criterion)")
        print(f"  stacked - vision : {(ck-cv)/n*100:+.1f}pp   (pure stacking lift, same rep)")


if __name__ == "__main__":
    main()
