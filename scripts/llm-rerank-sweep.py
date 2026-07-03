#!/usr/bin/env python3
"""SUPERSEDED / DO NOT TRUST (2026-07-03). Hardcodes VAULT=~/ObsidianBookmarks (the
deleted pre-move path) and the pre-split .roost/ layout, and bypasses the
contamination-safe honest_eval_lib. The fresh, provenance-audited rejection/rerank
eval is scripts/exp-rejection-fresh.py (+ rej_*.py). Kept only for history."""
"""Phase B: LLM reranks top-K=3 embedding candidates.

Sweeps 2 models (gemma4:e4b, llama3.2:3b) × 2 prompt templates (letter-pick, JSON-score).
Pure argmax metric — isolates ranking ability from rejection threshold.

Flags:
  --models=a,b  Only run the given models (comma-separated). Other cells are
                preserved from the existing results file on disk so partial
                reruns merge cleanly.
"""
import argparse
import json
import re
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import requests

VAULT = Path.home() / "ObsidianBookmarks"
ROOST = VAULT / ".roost"
CACHE_PATH = ROOST / "embedding-cache.json"
# Prefer the patched v2 fixture (13 unscorable items dropped) when present;
# fall back to v1 only if v2 hasn't been generated yet.
RESULTS_PATH = ROOST / "strategy-results-v2.json" if (ROOST / "strategy-results-v2.json").exists() else ROOST / "strategy-results.json"
DESC_PATH = ROOST / "collection-descriptions-contrastive.json"
OUT_PATH = ROOST / "llm-rerank-results.json"
CLIP_BIN_PATH = ROOST / "clip-vectors.bin"
TEXT_BIN_PATH = ROOST / "embedding-vectors.bin"
CLIP_VEC_DIM = 768
TEXT_VEC_DIM = 768

OLLAMA_URL = "http://localhost:11434/api/generate"
DEFAULT_MODELS = ["gemma4:e4b", "llama3.2:3b"]
DEFAULT_TOP_K = 3
ALL_LETTERS = "ABCDEFGHIJ"  # supports up to K=10


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


def _load_vectors_bin(path, dim):
    """Load vectors from a bin file with format: JSON keys array + '\\n' + raw Float32.
    Returns dict id→ndarray or empty dict on failure."""
    if not path.exists():
        return {}
    buf = path.read_bytes()
    nl = buf.find(b"\n")
    if nl < 0:
        return {}
    try:
        keys = json.loads(buf[:nl].decode("utf-8"))
    except Exception:
        return {}
    expected = len(keys) * dim * 4
    if len(buf) - (nl + 1) < expected:
        return {}
    floats = np.frombuffer(buf, dtype=np.float32, count=len(keys) * dim, offset=nl + 1)
    floats = floats.reshape(len(keys), dim)
    return {k: floats[i] for i, k in enumerate(keys)}


def load_text_vectors():
    """Load text embeddings from embedding-vectors.bin (the on-disk source after
    the JSON cache was split into text-only fields + binary vectors)."""
    return _load_vectors_bin(TEXT_BIN_PATH, TEXT_VEC_DIM)


def load_clip_vectors():
    """Load CLIP vectors from clip-vectors.bin."""
    return _load_vectors_bin(CLIP_BIN_PATH, CLIP_VEC_DIM)


def hydrate_cache_with_bin_vectors(cache):
    """Mutate cache in place so each entry that has a matching key in
    embedding-vectors.bin gets its `vec` field populated. The on-disk JSON
    no longer carries vectors — they live in the bin file."""
    text_map = load_text_vectors()
    hits = 0
    for key, vec in text_map.items():
        if key in cache:
            cache[key]["vec"] = vec.tolist()
            hits += 1
        else:
            cache[key] = {"vision": None, "summary": None, "category": None, "vec": vec.tolist()}
    return hits


def cos(a, b):
    den = float(np.linalg.norm(a) * np.linalg.norm(b))
    if den == 0:
        return 0.0
    return float(np.dot(a, b)) / (den + 1e-8)


def compute_topk(test_items, cache, members, centroids, top_k,
                 clip_map=None, clip_centroids=None, alpha=0.0):
    """Compute top-K embedding candidates per test item (sweep-matching LOO).

    Accepts both positive and negative items. For negatives (gt='No match'),
    the LOO branch is a no-op since 'No match' isn't in members/centroids, so
    every centroid is used as-is. Stores topk_sims alongside topk so a
    post-hoc FlatSim baseline can relabel by similarity without new LLM calls.

    When alpha > 0 and a CLIP vector + centroid are both available for a
    (item, collection) pair, similarity is fused as (1-alpha)*text + alpha*clip,
    matching production fusedSimilarity at src/pipeline/shared.ts. When either
    side is missing, fall back to pure text similarity for that pair.
    """
    fuse = alpha > 0.0 and clip_map is not None and clip_centroids is not None
    out = []
    for ti in test_items:
        iid = ti["id"]
        gt = ti["groundTruth"]
        is_negative = bool(ti.get("isNegative"))
        if iid not in cache or not cache[iid].get("vec"):
            continue
        vec = np.array(cache[iid]["vec"])
        clip_vec = clip_map.get(iid) if fuse else None
        sims = []
        for coll, centroid in centroids.items():
            if coll == gt and len(members[coll]) > 1:
                n = len(members[coll])
                if any(mid == iid for mid, _ in members[coll]):
                    use = (centroid * n - vec) / (n - 1)
                else:
                    use = centroid
            else:
                use = centroid
            text_sim = cos(vec, use)
            if fuse and clip_vec is not None and coll in clip_centroids:
                clip_cent = clip_centroids[coll]
                # Mirror production: leave-one-out for the matching collection
                clip_members = members.get(coll, [])
                if coll == gt and len(clip_members) > 1:
                    # CLIP centroid is computed only over members with clip vectors,
                    # so LOO needs the same restriction
                    own_clip = clip_map.get(iid)
                    if own_clip is not None:
                        # Recompute LOO clip centroid: subtract this item's clip vec
                        # from the cached sum. We can't easily recover the count here,
                        # so use the simpler "exclude self" recompute.
                        excl_vecs = [clip_map[mid] for mid, _ in clip_members
                                     if mid != iid and mid in clip_map]
                        if excl_vecs:
                            clip_cent = np.mean(np.stack(excl_vecs, axis=0), axis=0)
                clip_sim = cos(clip_vec, clip_cent)
                fused = (1.0 - alpha) * text_sim + alpha * clip_sim
                sims.append((coll, fused))
            else:
                sims.append((coll, text_sim))
        sims.sort(key=lambda x: -x[1])
        out.append({
            "id": iid,
            "gt": gt,
            "is_negative": is_negative,
            "summary": ti.get("summary", ""),
            "topk": [c for c, _ in sims[:top_k]],
            "topk_sims": [s for _, s in sims[:top_k]],
        })
    return out


def compute_clip_centroids(members, clip_map):
    """Per-collection mean over members that have CLIP vectors. Skip empty colls."""
    out = {}
    for coll, ms in members.items():
        vecs = [clip_map[mid] for mid, _ in ms if mid in clip_map]
        if vecs:
            out[coll] = np.mean(np.stack(vecs, axis=0), axis=0)
    return out


def build_t1_template(k):
    """Letter-pick template for K options. Uses placeholders name_A/desc_A/name_B/..."""
    letters = list(ALL_LETTERS[:k])
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


def build_t0_production_template(k):
    """Production TS prompt (src/pipeline/evaluate.ts::scoreAgainstCategories) verbatim.
    Uses numeric listing (1., 2., ...) but internally tracks candidates by letter
    so the shared format_prompt + topk->letter mapping still works.

    NOTE: Production also appends optional `NOT:` lines from generated contrastive
    descriptions. Those are runtime-generated and not stored — we skip them here to
    stay apples-to-apples with the rest of the sweep. This is the same simplification
    every other cell makes."""
    letters = list(ALL_LETTERS[:k])
    opts = "\n".join(f"{i + 1}. {{name_{L}}}: {{desc_{L}}}" for i, L in enumerate(letters))
    return (
        "Which category best fits this item? Rate the fit 1-10 (1=poor, 10=perfect).\n"
        "The item may not belong to any of these categories — only assign it if there is a genuine fit.\n\n"
        "Item: {summary}\n\n"
        "Categories:\n"
        f"{opts}\n\n"
        "Reply with the category number, fit score, and a brief reason.\n"
        "Example: 2 8 Strong focus on cooking techniques\n"
        "If none fit well, reply: 0 0 No match"
    )


def make_parse_t0_production(letters):
    """Mirrors parseBestPick in src/pipeline/evaluate.ts:
      - strip * and _
      - 'none' prefix → None (unmatched)
      - first two \\b\\d{1,2}\\b are catNum (1-indexed) and score
      - catNum 0 → None
      - return letter for catIdx if 1..k, score 1..10; else None

    Phase 0 measures PURE argmax accuracy (is GT picked?), so we do NOT apply the
    production threshold=7 gate here — that gate only affects the unmatched bucket
    for category discovery, not rerank correctness."""
    num_re = re.compile(r"\b(\d{1,2})\b")

    def parse(response):
        if not response:
            return None
        clean = response.replace("*", "").replace("_", "").strip()
        if not clean:
            return None
        if re.match(r"(?i)^none\b", clean):
            return None
        nums = num_re.findall(clean)
        if len(nums) >= 2:
            cat_num = int(nums[0])
            score = int(nums[1])
            if cat_num == 0:
                return None
            cat_idx = cat_num - 1
            if 0 <= cat_idx < len(letters) and 1 <= score <= 10:
                return letters[cat_idx]
            return None
        if len(nums) == 1 and int(nums[0]) == 0:
            return None
        return None

    return parse


def build_t1_none_template(k):
    """T1_letter with an explicit NONE slot. Hypothesis: forcing the LLM to
    pick a letter when no option fits causes it to anchor on the wrong answer
    (e.g. Minecraft videos assigned to D&D at sim=0.83 because both T1 and T2
    converge on the closest-looking wrong answer). Giving it an explicit
    refusal slot should let it reject poor fits without regressing good ones.

    The NONE letter is `N` — outside the A..G range used for K=7, so there is
    no collision with candidate slots. Parser maps `N` to None (picked_coll=None)
    which counts as incorrect on the 119-item positive test set. This lets the
    2pp regression gate measure the cost of adding the slot."""
    letters = list(ALL_LETTERS[:k])
    opts = "\n".join(f"{L}) {{name_{L}}}: {{desc_{L}}}" for L in letters)
    return (
        "You are categorizing a short video bookmark. Pick which collection best fits,\n"
        "or N if none of the collections below are a genuine fit for this video.\n\n"
        "Video summary: {summary}\n\n"
        "Options:\n"
        f"{opts}\n"
        "N) none of the above — the video doesn't match any collection listed\n\n"
        f"Respond with only a single letter: {', '.join(letters)}, or N."
    )


def make_parse_t1_none(letters):
    """Accepts A..<last> plus N. Returns the letter string; caller treats
    'N' as a refusal → picked_coll=None."""
    letter_class = "".join(letters) + "N"
    pattern = re.compile(rf'\b([{letter_class}])\b')

    def parse(response):
        if not response:
            return None
        m = pattern.search(response)
        return m.group(1) if m else None
    return parse


def build_t2_template(k):
    """JSON-score template for K options. Escapes example braces so they survive
    a later str.format(**fmt) call — single {{ / }} in the template become literal
    { / } in the final prompt."""
    letters = list(ALL_LETTERS[:k])
    opts = "\n".join(f"{L}) {{name_{L}}}: {{desc_{L}}}" for L in letters)
    example = "{{" + ", ".join(f'"{L}": {5 + i % 5}' for i, L in enumerate(letters)) + "}}"
    return (
        "Score how well this short video matches each collection on a scale of 1-10.\n\n"
        "Video summary: {summary}\n\n"
        f"{opts}\n\n"
        f"Respond with JSON only, like: {example}"
    )


def format_prompt(template, summary, topk_names, desc_of):
    """Fill placeholders name_A/desc_A/... for K candidates. Pads missing with '(none)'."""
    fmt = {"summary": (summary or "")[:500]}
    for i, L in enumerate(ALL_LETTERS[:len(topk_names)]):
        name = topk_names[i] if topk_names[i] else "(none)"
        fmt[f"name_{L}"] = name
        fmt[f"desc_{L}"] = desc_of(name)
    return template.format(**fmt)


def make_parse_t1(letters):
    letter_class = "".join(letters)
    pattern = re.compile(rf'\b([{letter_class}])\b')

    def parse(response):
        if not response:
            return None
        m = pattern.search(response)
        return m.group(1) if m else None
    return parse


def build_t2_none_template(k):
    """T2_json with an explicit N slot. Model scores each letter 1-10 AND
    assigns N a score — if N wins the argmax, the item is refused. The
    example body includes an N entry so the model reliably produces it."""
    letters = list(ALL_LETTERS[:k])
    opts = "\n".join(f"{L}) {{name_{L}}}: {{desc_{L}}}" for L in letters)
    body_parts = [f'"{L}": {5 + i % 5}' for i, L in enumerate(letters)]
    body_parts.append('"N": 0')
    example = "{{" + ", ".join(body_parts) + "}}"
    return (
        "Score how well this short video matches each collection on a scale of 1-10.\n"
        "Also score N — how well 'none of these fit' describes the video. If N\n"
        "has the highest score, the video doesn't belong to any listed collection.\n\n"
        "Video summary: {summary}\n\n"
        f"{opts}\n"
        "N) none of the above\n\n"
        f"Respond with JSON only, like: {example}"
    )


def make_parse_t2_none(letters):
    """Like parse_t2 but also accepts an 'N' key. Returns the winning letter,
    or 'N' if N has the highest score (caller treats as refusal)."""
    letter_set = set(letters) | {"N"}

    def parse(response):
        if not response:
            return None
        m = re.search(r'\{.*\}', response, re.DOTALL)
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
        for letter in list(letters) + ["N"]:
            hits = re.findall(rf'["\']?{letter}["\']?\s*:\s*(\d+(?:\.\d+)?)', response)
            if hits:
                scores[letter] = float(hits[0])
        if scores:
            return max(scores.items(), key=lambda kv: kv[1])[0]
        return None
    return parse


def make_parse_t2(letters):
    letter_set = set(letters)

    def parse(response):
        if not response:
            return None
        # Try JSON extraction first (allow nested objects for reasoning-model artifacts)
        m = re.search(r'\{.*\}', response, re.DOTALL)
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
        # Fallback: regex scan for `A: 7` or `"A": 7`
        scores = {}
        for letter in letters:
            hits = re.findall(rf'["\']?{letter}["\']?\s*:\s*(\d+(?:\.\d+)?)', response)
            if hits:
                scores[letter] = float(hits[0])
        if scores:
            return max(scores.items(), key=lambda kv: kv[1])[0]
        return None
    return parse


def call_ollama(model, prompt, num_predict=80):
    """Call Ollama generate endpoint. Passes `think: false` for gemma4 reasoning
    models — without it, gemma4 exhausts num_predict during internal thinking
    and returns empty content with done_reason=length.
    See https://github.com/ollama/ollama/issues/15260 (related gemma4 thinking bugs).
    """
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "think": False,  # no-op on non-reasoning models like llama3.2:3b
        "options": {"temperature": 0, "num_predict": num_predict},
    }
    try:
        resp = requests.post(OLLAMA_URL, json=payload, timeout=120)
        resp.raise_for_status()
        return resp.json().get("response", "")
    except Exception as e:
        return f"ERROR: {e}"


def resolve_cache_path(arg):
    """Resolve --cache arg: absolute path, or filename relative to .roost."""
    if not arg:
        return CACHE_PATH
    p = Path(arg)
    if p.is_absolute() and p.exists():
        return p
    if p.exists():
        return p.resolve()
    rel = ROOST / p.name
    if rel.exists():
        return rel
    raise FileNotFoundError(f"--cache path not found: {arg} (also tried {rel})")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", default=None,
                        help="Comma-separated list of models to run (default: all)")
    parser.add_argument("--cache", default=None,
                        help="Embedding cache filename (in .roost) or absolute path. "
                             "Default: embedding-cache.json")
    parser.add_argument("--tag", default=None,
                        help="Tag appended to result cell key as {model}/{tpl}/{tag}. "
                             "Lets different caches coexist in llm-rerank-results.json")
    parser.add_argument("--top-k", type=int, default=DEFAULT_TOP_K,
                        help=f"Number of candidates to rerank (default {DEFAULT_TOP_K}, max 10)")
    parser.add_argument("--templates", default=None,
                        help="Comma-separated subset of templates to run "
                             "(choices: T0_production, T1_letter, T2_json; default: T1_letter,T2_json)")
    parser.add_argument("--include-negatives", action="store_true",
                        help="Also evaluate on the 50 negative test items (groundTruth='No match'). "
                             "Measures true-refusal rate (TRR) alongside positive accuracy. "
                             "Result cells get extra positive_*/negative_*/combined_* fields.")
    parser.add_argument("--alpha", type=float, default=0.0,
                        help="CLIP-text fusion weight in [0, 1]. Default 0 (text-only). "
                             "Production uses 0.5. When > 0, loads clip-vectors.bin "
                             "and applies fused similarity at top-K selection.")
    args = parser.parse_args()
    models_to_run = [m.strip() for m in args.models.split(",")] if args.models else DEFAULT_MODELS
    cache_path = resolve_cache_path(args.cache)
    tag = args.tag.strip() if args.tag else None
    top_k = args.top_k
    if not 1 <= top_k <= len(ALL_LETTERS):
        raise ValueError(f"--top-k must be in [1, {len(ALL_LETTERS)}], got {top_k}")
    letters = list(ALL_LETTERS[:top_k])
    # Bigger candidate sets need more output tokens (especially JSON scores).
    # 80 covers K=3; scale linearly above that with headroom.
    num_predict = max(80, 30 + top_k * 20)

    print(f"Phase B — LLM rerank at K={top_k}")
    print("=" * 60)
    print(f"Models:      {models_to_run}")
    print(f"Cache:       {cache_path}")
    if tag:
        print(f"Tag:         {tag}")
    print(f"num_predict: {num_predict}")

    # Load prior results so partial reruns merge with existing cells
    if OUT_PATH.exists():
        try:
            all_results = json.load(open(OUT_PATH))
            print(f"Loaded {len(all_results)} existing result cells from {OUT_PATH}")
        except Exception:
            all_results = {}
    else:
        all_results = {}

    print("\nLoading data...")
    cache = json.load(open(cache_path))
    bin_hits = hydrate_cache_with_bin_vectors(cache)
    print(f"  hydrated {bin_hits} entries from embedding-vectors.bin")
    results = json.load(open(RESULTS_PATH))
    descriptions = json.load(open(DESC_PATH))
    labels = load_labels()

    members = defaultdict(list)
    for iid, coll in labels.items():
        if iid in cache and cache[iid].get("vec"):
            members[coll].append((iid, np.array(cache[iid]["vec"])))
    centroids = {c: np.mean([v for _, v in ms], axis=0) for c, ms in members.items() if ms}

    clip_map = None
    clip_centroids = None
    if args.alpha > 0:
        clip_map = load_clip_vectors()
        clip_centroids = compute_clip_centroids(members, clip_map)
        print(f"CLIP fusion: alpha={args.alpha}, items with CLIP vec: {len(clip_map)}, "
              f"collections with CLIP centroid: {len(clip_centroids)}")

    positive = [ti for ti in results["testItems"] if not ti["isNegative"]]
    negative = [ti for ti in results["testItems"] if ti["isNegative"]]
    test_items_src = positive + (negative if args.include_negatives else [])
    items = compute_topk(test_items_src, cache, members, centroids, top_k,
                         clip_map=clip_map, clip_centroids=clip_centroids, alpha=args.alpha)
    N = len(items)
    N_pos = sum(1 for it in items if not it["is_negative"])
    N_neg = sum(1 for it in items if it["is_negative"])
    if args.include_negatives:
        print(f"  {N_pos} positive + {N_neg} negative test items, top-{top_k} computed")
    else:
        print(f"  {N_pos} positive test items, top-{top_k} computed")

    pos_items = [it for it in items if not it["is_negative"]]
    in_topk = sum(1 for it in pos_items if it["gt"] in it["topk"])
    print(f"  GT in top-{top_k}: {in_topk}/{N_pos} ({in_topk/N_pos*100:.1f}%)  ← oracle ceiling (positives)")

    # Sanity-check that Ollama is reachable
    print("\nChecking Ollama availability...")
    for model in models_to_run:
        resp = call_ollama(model, "Reply with the letter A.")
        print(f"  {model}: {resp.strip()[:80]!r}")

    done = 0
    t_start = time.time()

    all_templates = {
        "T0_production": (build_t0_production_template(top_k), make_parse_t0_production(letters)),
        "T1_letter": (build_t1_template(top_k), make_parse_t1(letters)),
        "T2_json": (build_t2_template(top_k), make_parse_t2(letters)),
        "T1_letter_none": (build_t1_none_template(top_k), make_parse_t1_none(letters)),
        "T2_json_none": (build_t2_none_template(top_k), make_parse_t2_none(letters)),
    }
    if args.templates:
        wanted = [t.strip() for t in args.templates.split(",")]
        for w in wanted:
            if w not in all_templates:
                raise ValueError(f"--templates got {w!r}, must be one of {list(all_templates)}")
    else:
        wanted = ["T1_letter", "T2_json"]
    templates = [(name, *all_templates[name]) for name in wanted]
    total_calls = N * len(models_to_run) * len(templates)

    def desc_of(name):
        d = descriptions.get(name)
        return (d or name)[:300]

    for model in models_to_run:
        for tpl_name, tpl, tpl_parser in templates:
            print(f"\n--- {model} / {tpl_name} ---")
            pos_correct = 0
            pos_seen = 0
            neg_refused = 0
            neg_seen = 0
            parse_fail = 0
            picks = []

            for i, item in enumerate(items):
                topk = list(item["topk"])
                topk_sims = list(item["topk_sims"])
                while len(topk) < top_k:
                    topk.append("(none)")
                    topk_sims.append(0.0)

                prompt = format_prompt(tpl, item["summary"], topk, desc_of)
                resp = call_ollama(model, prompt, num_predict=num_predict)
                pick = tpl_parser(resp)
                done += 1

                picked_coll = None
                picked_sim = 0.0
                if pick in letters:
                    idx = letters.index(pick)
                    picked_coll = topk[idx]
                    picked_sim = topk_sims[idx]
                elif pick == "N":
                    # Explicit refusal (T*_none templates). Not a parse fail.
                    picked_coll = None
                else:
                    parse_fail += 1

                # Type-aware correctness:
                #   positive item: correct iff picked_coll == ground truth collection
                #   negative item: correct iff model refused (pick == 'N')
                # Parse fails are always wrong (picked_coll None without a refusal letter).
                is_neg = item["is_negative"]
                if is_neg:
                    neg_seen += 1
                    if pick == "N":
                        neg_refused += 1
                else:
                    pos_seen += 1
                    if picked_coll == item["gt"]:
                        pos_correct += 1

                picks.append({
                    "id": item["id"],
                    "gt": item["gt"],
                    "is_negative": is_neg,
                    "topk": topk,
                    "topk_sims": topk_sims,
                    "picked_sim": picked_sim,
                    "pick": pick,
                    "picked_coll": picked_coll,
                    "raw": resp[:200],
                })

                if (i + 1) % 10 == 0 or (i + 1) == N:
                    elapsed = time.time() - t_start
                    rate = done / elapsed if elapsed else 0
                    remaining = total_calls - done
                    eta_min = (remaining / rate / 60) if rate else 0
                    if args.include_negatives and neg_seen > 0:
                        pa = (pos_correct / pos_seen * 100) if pos_seen else 0.0
                        tr = (neg_refused / neg_seen * 100) if neg_seen else 0.0
                        print(f"  {i+1}/{N}  pos={pos_correct}/{pos_seen}({pa:.0f}%)  "
                              f"trr={neg_refused}/{neg_seen}({tr:.0f}%)  "
                              f"parse_fail={parse_fail}  rate={rate:.1f}/s  ETA={eta_min:.0f}min")
                    else:
                        acc_so_far = (pos_correct / pos_seen * 100) if pos_seen else 0.0
                        print(f"  {i+1}/{N}  acc={acc_so_far:.0f}%  "
                              f"parse_fail={parse_fail}  rate={rate:.1f}/s  "
                              f"ETA={eta_min:.0f}min")

            # Legacy fields (positive-only) stay in place so existing summary
            # tables and tooling keep working. Negative/combined fields are
            # additive and only present when --include-negatives was set.
            pos_acc_pct = (pos_correct / pos_seen * 100) if pos_seen else 0.0
            cell = f"{model}/{tpl_name}/{tag}" if tag else f"{model}/{tpl_name}"
            cell_data = {
                "correct": pos_correct,
                "total": pos_seen,
                "accuracy": pos_acc_pct,
                "parse_fail": parse_fail,
                "picks": picks,
            }
            if args.include_negatives:
                combined_correct = pos_correct + neg_refused
                combined_total = pos_seen + neg_seen
                combined_acc = (combined_correct / combined_total) if combined_total else 0.0
                trr = (neg_refused / neg_seen) if neg_seen else 0.0
                cell_data.update({
                    "include_negatives": True,
                    "positive_correct": pos_correct,
                    "positive_total": pos_seen,
                    "positive_accuracy": pos_correct / pos_seen if pos_seen else 0.0,
                    "negative_refused": neg_refused,
                    "negative_total": neg_seen,
                    "trr": trr,
                    "combined_correct": combined_correct,
                    "combined_total": combined_total,
                    "combined_accuracy": combined_acc,
                })
                print(f"  RESULT {cell}:")
                print(f"    positive: {pos_correct}/{pos_seen} ({pos_acc_pct:.1f}%)")
                print(f"    negative refused: {neg_refused}/{neg_seen} ({trr*100:.1f}%)  ← TRR")
                print(f"    combined: {combined_correct}/{combined_total} ({combined_acc*100:.1f}%)")
                print(f"    parse_fail: {parse_fail}")
            else:
                print(f"  RESULT {cell}: {pos_correct}/{pos_seen} = {pos_acc_pct:.1f}%  parse_fail={parse_fail}")
            all_results[cell] = cell_data

            # Save incrementally in case of crash mid-sweep
            json.dump(all_results, open(OUT_PATH, "w"))

    # Summary
    print(f"\n{'='*70}")
    print(f"PHASE B RESULTS — LLM rerank at K={top_k}")
    print(f"{'='*70}")
    print(f"  Positive baseline (embedding top-1): 70/{N_pos} (58.8%)")
    print(f"  Oracle ceiling (GT in top-{top_k}):        {in_topk}/{N_pos} ({in_topk/N_pos*100:.1f}%)")
    print()
    print(f"  {'Cell':<42} {'Pos acc':<16} {'TRR':<12} {'Combined':<14} Parse")
    print(f"  {'-'*94}")
    for cell, r in all_results.items():
        pos_c = r.get("correct", 0)
        pos_t = r.get("total", 0)
        pos_pct = r.get("accuracy", 0.0)
        pos_str = f"{pos_c}/{pos_t} ({pos_pct:.1f}%)"
        if r.get("include_negatives"):
            nr = r.get("negative_refused", 0)
            nt = r.get("negative_total", 0)
            trr_pct = r.get("trr", 0.0) * 100
            trr_str = f"{nr}/{nt} ({trr_pct:.0f}%)"
            cc = r.get("combined_correct", 0)
            ct = r.get("combined_total", 0)
            ca_pct = r.get("combined_accuracy", 0.0) * 100
            comb_str = f"{cc}/{ct} ({ca_pct:.1f}%)"
        else:
            trr_str = "—"
            comb_str = "—"
        pf = r.get("parse_fail", 0)
        print(f"  {cell:<42} {pos_str:<16} {trr_str:<12} {comb_str:<14} {pf}")
    print(f"{'='*70}")
    print(f"\nDetailed picks saved to {OUT_PATH}")


if __name__ == "__main__":
    main()
