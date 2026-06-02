#!/usr/bin/env python3
"""Phase 5: FPR + threshold tuning for the Phase 3/4 ensemble pipeline.

Runs the same T1_letter(K=5) + T2_json(K=7) ensemble that production deploys,
but on all 169 test items (119 positives + 50 negatives). Reuses positive picks
from phase4-t1k5-fixed / phase4-t2k7-fixed (already in llm-rerank-results.json)
so only the 50 negatives need fresh LLM calls. Then records the picked-candidate
centroid similarity for every item and sweeps SIM_THRESHOLD to find best F1.

Definitions:
  - True Positive  (TP): positive item, picked collection == gt, sim >= T
  - False Positive (FP): negative item, sim >= T (any pick; negatives have no match)
  - False Negative (FN): positive item, (picked != gt) OR (sim < T)
  - True Negative  (TN): negative item, sim < T

F1 = 2*TP / (2*TP + FP + FN).

Writes detailed per-item results to `.roost/phase5-threshold-results.json`.
"""
import argparse
import json
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import requests

VAULT = Path.home() / "ObsidianBookmarks"
ROOST = VAULT / ".roost"
CACHE_PATH = ROOST / "embedding-cache.json"
RESULTS_PATH = ROOST / "strategy-results.json"
DESC_PATH = ROOST / "collection-descriptions-contrastive.json"
RERANK_OUT = ROOST / "llm-rerank-results.json"
PHASE5_OUT = ROOST / "phase5-threshold-results.json"

OLLAMA_URL = "http://localhost:11434/api/generate"
MODEL = "gemma4:e4b"
K_SMALL = 5
K_LARGE = 7
LETTERS = "ABCDEFGHIJ"


# ── Shared helpers mirrored from llm-rerank-sweep.py ──

def load_labels():
    labels = {}
    for md in (VAULT / "Bookmarks").rglob("*.md"):
        try:
            content = md.read_text(encoding="utf-8")
        except Exception:
            continue
        if not content.startswith("---\n"):
            continue
        end = content.find("\n---", 4)
        if end < 0:
            continue
        fm = content[4:end]
        id_match = re.search(r'^roost_id:\s*"?([^"\n]+)"?', fm, re.MULTILINE)
        if not id_match:
            continue
        rid = id_match.group(1).strip()
        coll_match = re.search(r'^collection:\s*(.+)', fm, re.MULTILINE)
        cat_match = re.search(r'^roost_category:\s*(.+)', fm, re.MULTILINE)
        cat = cat_match.group(1) if cat_match else (coll_match.group(1) if coll_match else None)
        if not cat:
            continue
        cat = cat.strip().strip('"')
        if cat and cat not in ("undefined", "null"):
            labels[rid] = cat
    return labels


def compute_topk(items, cache, members, centroids, top_k, is_positive):
    """Compute top-K with LOO for positives in training set; plain cosine for negatives."""
    out = []
    for ti in items:
        iid = ti["id"]
        if iid not in cache or not cache[iid].get("vec"):
            continue
        vec = np.array(cache[iid]["vec"])
        gt = ti["groundTruth"]
        sims = []
        for coll, centroid in centroids.items():
            if is_positive and coll == gt and len(members[coll]) > 1:
                n = len(members[coll])
                if any(mid == iid for mid, _ in members[coll]):
                    use = (centroid * n - vec) / (n - 1)
                else:
                    use = centroid
            else:
                use = centroid
            num = float(np.dot(vec, use))
            den = np.linalg.norm(vec) * np.linalg.norm(use)
            sims.append((coll, num / (den + 1e-8)))
        sims.sort(key=lambda x: -x[1])
        out.append({
            "id": iid,
            "gt": gt,
            "summary": ti.get("summary", ""),
            "topk": [c for c, _ in sims[:top_k]],
            "topk_sims": [float(s) for _, s in sims[:top_k]],
        })
    return out


def build_t1_template(k):
    letters = list(LETTERS[:k])
    opts = "\n".join(f"{L}) {{name_{L}}}: {{desc_{L}}}" for L in letters)
    if k == 1:
        tail = letters[0]
    elif k == 2:
        tail = f"{letters[0]} or {letters[1]}"
    else:
        tail = ", ".join(letters[:-1]) + f", or {letters[-1]}"
    return (
        "You are categorizing a short video bookmark. Pick which collection best fits.\n\n"
        "Video summary: {summary}\n\n"
        "Options:\n"
        f"{opts}\n\n"
        f"Respond with only a single letter: {tail}."
    )


def build_t2_template(k):
    letters = list(LETTERS[:k])
    opts = "\n".join(f"{L}) {{name_{L}}}: {{desc_{L}}}" for L in letters)
    example = "{{" + ", ".join(f'"{L}": {5 + i % 5}' for i, L in enumerate(letters)) + "}}"
    return (
        "Score how well this short video matches each collection on a scale of 1-10.\n\n"
        "Video summary: {summary}\n\n"
        f"{opts}\n\n"
        f"Respond with JSON only, like: {example}"
    )


def format_prompt(template, summary, topk_names, desc_of):
    fmt = {"summary": (summary or "")[:500]}
    for i, L in enumerate(LETTERS[:len(topk_names)]):
        name = topk_names[i] if topk_names[i] else "(none)"
        fmt[f"name_{L}"] = name
        fmt[f"desc_{L}"] = desc_of(name)
    return template.format(**fmt)


def parse_t1(raw, letters):
    if not raw:
        return None
    m = re.search(rf'\b([{"".join(letters)}])\b', raw)
    return m.group(1) if m else None


def parse_t2(raw, letters):
    if not raw:
        return None
    letter_set = set(letters)
    m = re.search(r'\{.*\}', raw, re.DOTALL)
    if m:
        try:
            obj = json.loads(m.group(0))
            if isinstance(obj, dict):
                scores = {}
                for k, v in obj.items():
                    kk = str(k).strip().upper()
                    if kk in letter_set:
                        try:
                            scores[kk] = float(v)
                        except Exception:
                            pass
                if scores:
                    return max(scores.items(), key=lambda kv: kv[1])[0]
        except Exception:
            pass
    scores = {}
    for L in letters:
        hits = re.findall(rf'["\']?{L}["\']?\s*:\s*(\d+(?:\.\d+)?)', raw)
        if hits:
            scores[L] = float(hits[0])
    if scores:
        return max(scores.items(), key=lambda kv: kv[1])[0]
    return None


def call_ollama(model, prompt, num_predict):
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "think": False,
        "options": {"temperature": 0, "num_predict": num_predict},
    }
    try:
        resp = requests.post(OLLAMA_URL, json=payload, timeout=120)
        resp.raise_for_status()
        return resp.json().get("response", "")
    except Exception as e:
        return f"ERROR: {e}"


# ── Ensemble tiebreak (mirrors evaluate.ts + audit-dashboard.py) ──

def ensemble_pick(t1_pick, t2_pick, top7):
    """Returns picked_idx into top7 (0..6) or None."""
    if t1_pick is None and t2_pick is None:
        return None
    if t1_pick == t2_pick:
        return t1_pick  # already an index
    if t1_pick is None:
        return t2_pick
    if t2_pick is None:
        return t1_pick
    # tiebreak: lower index (= higher centroid sim) in top7 wins
    return t1_pick if t1_pick < t2_pick else t2_pick


# ── Main ──

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reuse-positives", action="store_true", default=True,
                    help="Reuse positive picks from phase4-t1k5-fixed/phase4-t2k7-fixed "
                         "(default: true). Otherwise runs LLM on all 169 items.")
    ap.add_argument("--no-reuse-positives", dest="reuse_positives", action="store_false")
    args = ap.parse_args()

    print("Phase 5 — threshold sweep on negatives + positives")
    print("=" * 60)
    print(f"Cache:  {CACHE_PATH}")
    print(f"Model:  {MODEL}  K_small={K_SMALL}  K_large={K_LARGE}")

    cache = json.load(open(CACHE_PATH))
    results = json.load(open(RESULTS_PATH))
    descriptions = json.load(open(DESC_PATH))
    labels = load_labels()
    rerank = json.load(open(RERANK_OUT)) if RERANK_OUT.exists() else {}

    members = defaultdict(list)
    for iid, coll in labels.items():
        if iid in cache and cache[iid].get("vec"):
            members[coll].append((iid, np.array(cache[iid]["vec"])))
    centroids = {c: np.mean([v for _, v in ms], axis=0) for c, ms in members.items() if ms}

    positive = [ti for ti in results["testItems"] if not ti["isNegative"]]
    negative = [ti for ti in results["testItems"] if ti["isNegative"]]
    print(f"Pos: {len(positive)}  Neg: {len(negative)}")

    pos_topk = compute_topk(positive, cache, members, centroids, K_LARGE, is_positive=True)
    neg_topk = compute_topk(negative, cache, members, centroids, K_LARGE, is_positive=False)

    letters_small = list(LETTERS[:K_SMALL])
    letters_large = list(LETTERS[:K_LARGE])
    t1_tpl = build_t1_template(K_SMALL)
    t2_tpl = build_t2_template(K_LARGE)

    def desc_of(name):
        d = descriptions.get(name)
        return (d or name)[:300]

    # ── Reuse existing positive picks if asked ──
    pos_pick_map = {}
    if args.reuse_positives:
        t1_cell = rerank.get(f"{MODEL}/T1_letter/phase4-t1k5-fixed")
        t2_cell = rerank.get(f"{MODEL}/T2_json/phase4-t2k7-fixed")
        if t1_cell and t2_cell:
            a = {x["id"]: x for x in t1_cell["picks"]}
            b = {x["id"]: x for x in t2_cell["picks"]}
            for iid in a:
                if iid in b:
                    pos_pick_map[iid] = (a[iid], b[iid])
            print(f"Reusing {len(pos_pick_map)} positive picks from phase4 cells")

    # Sanity check: reused picks must match the CURRENT topk (centroids may have drifted
    # since the sweep that produced those cells — unlikely after Phase 4 but verify).
    drift = 0
    for it in pos_topk:
        if it["id"] in pos_pick_map:
            a, b = pos_pick_map[it["id"]]
            if list(a["topk"])[:K_SMALL] != it["topk"][:K_SMALL]:
                drift += 1
            if list(b["topk"]) != it["topk"]:
                drift += 1
    if drift:
        print(f"WARNING: {drift} drift mismatches between reused picks and current topk — will re-run those.")

    # Ensure Ollama reachable
    print("\nPinging Ollama...")
    print(f"  {MODEL}: {call_ollama(MODEL, 'Reply with A.', 10).strip()[:40]!r}")

    t1_num_predict = 10
    t2_num_predict = max(80, 30 + K_LARGE * 20)  # = 170

    def run_item(it, tag_prefix):
        """Run T1 + T2 LLM calls for a single item. Returns (a_pick_letter, t1_raw, b_pick_letter, t2_raw)."""
        topk = list(it["topk"])
        while len(topk) < K_LARGE:
            topk.append("(none)")
        top5 = topk[:K_SMALL]
        t1_prompt = format_prompt(t1_tpl, it["summary"], top5, desc_of)
        t2_prompt = format_prompt(t2_tpl, it["summary"], topk, desc_of)
        t1_raw = call_ollama(MODEL, t1_prompt, num_predict=t1_num_predict)
        t2_raw = call_ollama(MODEL, t2_prompt, num_predict=t2_num_predict)
        a_letter = parse_t1(t1_raw, letters_small)
        b_letter = parse_t2(t2_raw, letters_large)
        return a_letter, t1_raw, b_letter, t2_raw

    all_rows = []  # { id, isNegative, gt, topk, topk_sims, a_idx, b_idx, final_idx, picked, picked_sim }

    # ── Positives ──
    print(f"\nProcessing {len(pos_topk)} positives...")
    t0 = time.time()
    for i, it in enumerate(pos_topk):
        topk = it["topk"]
        sims = it["topk_sims"]
        iid = it["id"]
        reused = iid in pos_pick_map

        if reused and len(pos_pick_map[iid][1]["topk"]) == K_LARGE and list(pos_pick_map[iid][1]["topk"]) == topk:
            a_entry, b_entry = pos_pick_map[iid]
            a_letter = a_entry.get("pick")
            b_letter = b_entry.get("pick")
        else:
            a_letter, _, b_letter, _ = run_item(it, "pos")

        a_idx = letters_small.index(a_letter) if a_letter in letters_small else None
        b_idx = letters_large.index(b_letter) if b_letter in letters_large else None
        final_idx = ensemble_pick(a_idx, b_idx, topk)
        if final_idx is not None:
            picked = topk[final_idx]
            picked_sim = sims[final_idx]
        else:
            picked = None
            picked_sim = None
        all_rows.append({
            "id": iid,
            "isNegative": False,
            "gt": it["gt"],
            "topk": topk,
            "topk_sims": sims,
            "a_idx": a_idx,
            "b_idx": b_idx,
            "final_idx": final_idx,
            "picked": picked,
            "picked_sim": picked_sim,
        })

    print(f"  positives done in {time.time() - t0:.0f}s")

    # ── Negatives ──
    print(f"\nProcessing {len(neg_topk)} negatives...")
    t0 = time.time()
    for i, it in enumerate(neg_topk):
        topk = it["topk"]
        sims = it["topk_sims"]
        iid = it["id"]
        a_letter, t1_raw, b_letter, t2_raw = run_item(it, "neg")
        a_idx = letters_small.index(a_letter) if a_letter in letters_small else None
        b_idx = letters_large.index(b_letter) if b_letter in letters_large else None
        final_idx = ensemble_pick(a_idx, b_idx, topk)
        if final_idx is not None:
            picked = topk[final_idx]
            picked_sim = sims[final_idx]
        else:
            picked = None
            picked_sim = None
        all_rows.append({
            "id": iid,
            "isNegative": True,
            "gt": it["gt"],
            "topk": topk,
            "topk_sims": sims,
            "a_idx": a_idx,
            "b_idx": b_idx,
            "final_idx": final_idx,
            "picked": picked,
            "picked_sim": picked_sim,
            "t1_raw": t1_raw[:120],
            "t2_raw": t2_raw[:160],
        })
        if (i + 1) % 10 == 0 or i + 1 == len(neg_topk):
            elapsed = time.time() - t0
            rate = (i + 1) / elapsed if elapsed else 0
            print(f"  {i+1}/{len(neg_topk)}  rate={rate:.1f}/s")

    # ── Threshold sweep ──
    def metrics_at(T):
        tp = fp = fn = tn = 0
        for r in all_rows:
            is_neg = r["isNegative"]
            sim = r["picked_sim"]
            picked = r["picked"]
            assigned = (picked is not None) and (sim is not None) and (sim >= T)
            if is_neg:
                if assigned:
                    fp += 1
                else:
                    tn += 1
            else:
                gt_match = (picked == r["gt"])
                if assigned and gt_match:
                    tp += 1
                else:
                    fn += 1
        prec = tp / (tp + fp) if (tp + fp) else 0
        rec  = tp / (tp + fn) if (tp + fn) else 0
        f1   = 2 * prec * rec / (prec + rec) if (prec + rec) else 0
        return tp, fp, fn, tn, prec, rec, f1

    sims_sorted = sorted({round(r["picked_sim"], 4) for r in all_rows if r["picked_sim"] is not None})
    # Also include round numbers for readability
    candidates = sorted(set([0.0, 0.05, 0.10] + [round(0.40 + 0.025 * k, 3) for k in range(25)] + sims_sorted))

    print("\n" + "=" * 70)
    print("THRESHOLD SWEEP")
    print("=" * 70)
    print(f"{'T':>7}  {'TP':>4}  {'FP':>4}  {'FN':>4}  {'TN':>4}  {'P':>6}  {'R':>6}  {'F1':>6}")
    best_f1 = -1
    best_T = 0
    best_row = None
    for T in candidates:
        m = metrics_at(T)
        if m[6] > best_f1:
            best_f1 = m[6]
            best_T = T
            best_row = m
        if T in (0.0, 0.05, 0.10) or (T * 100) % 5 == 0:
            tp, fp, fn, tn, p, r, f1 = m
            print(f"{T:7.3f}  {tp:4d}  {fp:4d}  {fn:4d}  {tn:4d}  {p:.3f}  {r:.3f}  {f1:.3f}")

    print("\nBest:")
    tp, fp, fn, tn, p, r, f1 = best_row
    print(f"  T={best_T:.3f}  TP={tp} FP={fp} FN={fn} TN={tn}  P={p:.3f} R={r:.3f} F1={f1:.3f}")

    # Pure argmax (T=0) and deployed baseline
    print("\nT=0 (pure argmax, current deployed):")
    tp, fp, fn, tn, p, r, f1 = metrics_at(0.0)
    print(f"  TP={tp} FP={fp} FN={fn} TN={tn}  P={p:.3f} R={r:.3f} F1={f1:.3f}")

    # Save
    out = {
        "model": MODEL,
        "k_small": K_SMALL,
        "k_large": K_LARGE,
        "rows": all_rows,
        "sweep": [
            {"T": T, **dict(zip(["tp","fp","fn","tn","precision","recall","f1"], metrics_at(T)))}
            for T in candidates
        ],
        "best": {"T": best_T, "tp": best_row[0], "fp": best_row[1], "fn": best_row[2], "tn": best_row[3],
                 "precision": best_row[4], "recall": best_row[5], "f1": best_row[6]},
    }
    json.dump(out, open(PHASE5_OUT, "w"), indent=2)
    print(f"\nSaved: {PHASE5_OUT}")


if __name__ == "__main__":
    main()
