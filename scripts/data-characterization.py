"""Stage 0 — Data characterization.

Reads ROOST_VAULT, reports per-platform (tiktok/twitter):
  - note counts (with cached embeddings)
  - fraction with a non-empty subtitle (transcript field)
  - fraction with each embed-text field present (vision/summary/title/subtitle)
  - honest-label (collection) count + per-category distribution
  - per-platform fixture sizes from eval-fixture-large.json
  - heuristic flag for 'likely music/noise subtitle' (best-effort, clearly labeled)

Operator-run: requires ROOST_VAULT + a populated cache + built fixtures.
Run:
  ROOST_VAULT=<vault> python scripts/data-characterization.py [--fixture large]
"""
import os, sys, json, glob, re, argparse
from collections import Counter, defaultdict
import honest_eval_lib as L

# ── Heuristic: music / noise subtitle detection ────────────────────────────────

_MUSIC_TOKENS = re.compile(
    r"\b(music|beat|chorus|verse|hook|bridge|drop|instrumental|"
    r"audio|sound|noise|track|bpm|loop|sample|melody|rhythm|"
    r"uh+|oh+|ah+|hmm+|yeah+|na na|la la|do do)\b",
    re.I,
)
_REPEATED_TOKEN = re.compile(r"\b(\w{2,})\b(?:.*?\b\1\b){3,}")  # same token 4+ times


def _is_likely_music_noise(subtitle: str) -> bool:
    """Heuristic (best-effort) flag — very short OR dominated by music tokens OR
    heavily repeated tokens. NOT used for GT or scoring — diagnostic only."""
    s = subtitle.strip()
    if not s:
        return False
    # Very short subtitles (<= 8 words) often carry no semantic signal
    word_count = len(s.split())
    if word_count <= 8:
        return True
    # Music keyword density > 30 %
    music_hits = len(_MUSIC_TOKENS.findall(s))
    if music_hits / word_count > 0.30:
        return True
    # Heavily repeated tokens
    if _REPEATED_TOKEN.search(s):
        return True
    return False


# ── Front-matter field reader ──────────────────────────────────────────────────

_FM_RE = re.compile(r"^---\n(.*?)\n---", re.S)
_BODY_AFTER_FM = re.compile(r"^---\n.*?\n---\n?(.*)", re.S)

# Fields that appear in Roost frontmatter
_ROOST_FIELDS = {
    "roost_id", "platform", "collection", "roost_category",
    "roost_assigned_by", "roost_title", "roost_subtitle",
    "roost_summary", "roost_vision", "roost_embed_text",
}


def _parse_fm(path: str) -> dict:
    """Return a dict of frontmatter fields for a vault .md file. Returns {} on error."""
    try:
        with open(path, encoding="utf-8") as fh:
            content = fh.read(65_536)  # cap read at 64 KB — no content needed
    except OSError:
        return {}
    m = _FM_RE.match(content)
    if not m:
        return {}
    fm: dict = {}
    for line in m.group(1).split("\n"):
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        if key in _ROOST_FIELDS:
            fm[key] = val.strip().strip('"').strip("'")
    return fm


# ── Per-note characterizer ─────────────────────────────────────────────────────

def _note_fields(fm: dict) -> dict:
    """Derive presence flags for embed-text fields from a frontmatter dict."""
    subtitle = fm.get("roost_subtitle", "")
    vision = fm.get("roost_vision", "")
    summary = fm.get("roost_summary", "")
    title = fm.get("roost_title", "")
    # 'embed_text' is the fused string Roost passes to the embedding model
    embed_text = fm.get("roost_embed_text", "")

    has_subtitle = bool(subtitle)
    has_vision = bool(vision)
    has_summary = bool(summary)
    has_title = bool(title)
    has_embed_text = bool(embed_text)
    music_noise = _is_likely_music_noise(subtitle) if has_subtitle else False

    return {
        "has_subtitle": has_subtitle,
        "has_vision": has_vision,
        "has_summary": has_summary,
        "has_title": has_title,
        "has_embed_text": has_embed_text,
        "music_noise_subtitle": music_noise,
        "subtitle_text": subtitle,  # kept for reference, not aggregated
    }


# ── Aggregator ────────────────────────────────────────────────────────────────

def _pct(n: int, total: int) -> str:
    return f"{n / total * 100:.1f}%" if total else "—"


def _report_platform(plat: str, notes: list, label_counts: Counter,
                     fixture_count: int) -> None:
    n = len(notes)
    if n == 0:
        print(f"  [no notes found for platform={plat!r}]")
        return

    fields = ["has_subtitle", "has_vision", "has_summary", "has_title",
              "has_embed_text", "music_noise_subtitle"]
    sums = {f: sum(1 for nd in notes if nd.get(f)) for f in fields}

    print(f"  total notes (with cached embedding): {n}")
    print(f"  honest-labeled notes (collection):   {sum(label_counts.values())}  ({_pct(sum(label_counts.values()), n)} of total)")
    print(f"  fixture items (eval-fixture-large):  {fixture_count}")
    print()
    print("  Embed-text field presence:")
    for f in ["has_title", "has_summary", "has_vision", "has_subtitle", "has_embed_text"]:
        label = {
            "has_title": "title",
            "has_summary": "summary (LLM vision output)",
            "has_vision": "vision (raw vision cache)",
            "has_subtitle": "subtitle / transcript",
            "has_embed_text": "embed_text (fused string)",
        }[f]
        print(f"    {label:<38} {sums[f]:>6}  ({_pct(sums[f], n)})")
    sub_total = sums["has_subtitle"]
    music_total = sums["music_noise_subtitle"]
    print()
    print(f"  Heuristic 'likely music/noise subtitle' [BEST-EFFORT, NOT GT]:")
    print(f"    of {sub_total} notes with a subtitle, ~{music_total} ({_pct(music_total, sub_total)}) "
          f"appear music/noise")
    print(f"    (very short ≤8 words, music keyword density >30%, or heavily repeated tokens)")
    print()
    print("  Per-category label distribution (honest collection):")
    if label_counts:
        max_w = max(len(k) for k in label_counts)
        for cat, cnt in label_counts.most_common():
            bar = "#" * min(40, cnt)
            print(f"    {cat:<{max_w}}  {cnt:>4}  {bar}")
    else:
        print("    (none)")


def main():
    ap = argparse.ArgumentParser(description="Stage 0 data characterization")
    ap.add_argument("--fixture", default="large",
                    choices=["large", "dev", "holdout"],
                    help="Which fixture split to size-report (default: large)")
    ap.add_argument("--sync-folder", default="Bookmarks",
                    help="Subfolder under ROOST_VAULT to scan (default: Bookmarks)")
    args = ap.parse_args()

    vault = os.environ.get("ROOST_VAULT")
    if not vault:
        sys.exit("ERROR: ROOST_VAULT not set")
    build = os.path.join(vault, ".roost", "build")

    # ── Load cache (tells us which notes have embeddings) ────────────────────
    cache = L.load_cache(
        bin_path=os.path.join(vault, ".roost", "cache", "embedding-vectors.bin")
    )
    if not cache:
        sys.exit("ERROR: embedding cache empty or not found — run the sidecar first")
    print(f"Cache: {len(cache)} embeddings loaded")

    # ── Load honest labels (collection field, non-auto) ───────────────────────
    labels, _negatives = L.load_honest_labels(vault, sync_folder=args.sync_folder)
    print(f"Honest labels: {len(labels)} items")

    # ── Load fixture to get per-platform sizes ────────────────────────────────
    fixture_path = os.path.join(build, f"eval-fixture-{args.fixture}.json")
    if not os.path.exists(fixture_path):
        print(f"WARNING: fixture not found at {fixture_path} — fixture counts will be 0")
        fixture_items = []
    else:
        with open(fixture_path, encoding="utf-8") as fh:
            fixture_data = json.load(fh)
        fixture_items = fixture_data.get("testItems", [])
    fixture_ids = {t["id"] for t in fixture_items}

    # We need to know the platform of each fixture item — scan their frontmatter
    fixture_platforms: dict[str, str] = {}  # roost_id -> platform

    # ── Scan vault notes ──────────────────────────────────────────────────────
    scan_dir = os.path.join(vault, args.sync_folder)
    if not os.path.isdir(scan_dir):
        sys.exit(f"ERROR: sync folder not found: {scan_dir}")

    by_platform: dict[str, list] = defaultdict(list)
    label_counts_by_platform: dict[str, Counter] = defaultdict(Counter)
    fixture_by_platform: dict[str, int] = defaultdict(int)

    md_files = glob.glob(os.path.join(scan_dir, "**", "*.md"), recursive=True)
    print(f"Scanning {len(md_files)} .md files in {scan_dir} …")

    for path in md_files:
        fm = _parse_fm(path)
        rid = fm.get("roost_id")
        if not rid:
            continue
        if rid not in cache:
            continue  # skip notes without an embedding
        plat = fm.get("platform", "unknown").lower()
        fields = _note_fields(fm)
        fields["roost_id"] = rid
        by_platform[plat].append(fields)

        # Honest label
        if rid in labels:
            label_counts_by_platform[plat][labels[rid]] += 1

        # Fixture membership
        if rid in fixture_ids:
            fixture_by_platform[plat] += 1
            fixture_platforms[rid] = plat

    # ── Report ────────────────────────────────────────────────────────────────
    print()
    print("=" * 70)
    print(f"STAGE 0 — DATA CHARACTERIZATION  (fixture split: {args.fixture})")
    print("=" * 70)
    print(f"Vault: {vault}")
    print(f"Total cached notes scanned: {sum(len(v) for v in by_platform.values())}")
    print(f"Total fixture items ({args.fixture}): {len(fixture_items)}")
    print()

    for plat in sorted(by_platform.keys()):
        print(f"── PLATFORM: {plat.upper()} ──────────────────────────────────────────────")
        _report_platform(
            plat,
            by_platform[plat],
            label_counts_by_platform[plat],
            fixture_by_platform[plat],
        )
        print()

    # ── Overall summary ───────────────────────────────────────────────────────
    print("── OVERALL SUMMARY ───────────────────────────────────────────────────")
    all_notes = sum(len(v) for v in by_platform.values())
    all_with_sub = sum(
        sum(1 for nd in v if nd["has_subtitle"]) for v in by_platform.values()
    )
    all_music = sum(
        sum(1 for nd in v if nd["music_noise_subtitle"]) for v in by_platform.values()
    )
    print(f"  Total notes with cached embedding: {all_notes}")
    print(f"  With subtitle/transcript:          {all_with_sub}  ({_pct(all_with_sub, all_notes)})")
    print(f"  Heuristic music/noise subtitle:    {all_music}  ({_pct(all_music, all_with_sub)} of subtitle-bearing)")
    print(f"  Honest-labeled total:              {len(labels)}")
    print(f"  Fixture ({args.fixture}) total:    {len(fixture_items)}")
    print()
    print("NOTE: 'heuristic music/noise subtitle' is a best-effort diagnostic flag,")
    print("      not used for GT or any scoring. Inspect false positives before acting on it.")


if __name__ == "__main__":
    main()
