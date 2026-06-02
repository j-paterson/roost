#!/usr/bin/env python3
"""Audit dashboard for the 34 ensemble-wrong failures at SOTA 85/119.

Serves a single-page HTML dashboard at http://localhost:8765 that walks the
user through each failure, showing title/summary/vision + GT vs ensemble pick
with collection descriptions. Classifications are written as JSONL to
`.roost/failure-audit-log.jsonl` — one line per submit, last-write-wins per id.

Usage:
    ~/ObsidianBookmarks/.roost/venv/bin/python scripts/audit-dashboard.py
    open http://localhost:8765

Log format (JSONL, one item per line):
    {"id": "...", "gt": "...", "ensemble_pick": "...", "category": "...",
     "notes": "...", "audited_at": "2026-04-10T..."}

Categories:
    ambiguous      — both GT and model pick are valid, GT reflects user preference
    mislabeled     — summary/content does not actually match GT (data / labeler error)
    reasoning_gap  — model pick is clearly wrong; GT is obviously correct
    unclear        — can't tell from available info
"""
import json
import os
import re
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

VAULT = Path.home() / "ObsidianBookmarks"
ROOST = VAULT / ".roost"
RESULTS_PATH = ROOST / "llm-rerank-results.json"
DESC_PATH = ROOST / "collection-descriptions-contrastive.json"
CACHE_PATH = ROOST / "embedding-cache.json"
LOG_PATH = ROOST / "failure-audit-log.jsonl"

PORT = 8765


def load_vault_titles():
    """Scan Bookmarks/ md files and return {roost_id: {title, url}}."""
    out = {}
    for md in (VAULT / "Bookmarks").rglob("*.md"):
        try:
            c = md.read_text(encoding="utf-8")
        except Exception:
            continue
        if not c.startswith("---\n"):
            continue
        end = c.find("\n---", 4)
        if end < 0:
            continue
        fm = c[4:end]
        id_match = re.search(r'^roost_id:\s*"?([^"\n]+)"?', fm, re.MULTILINE)
        if not id_match:
            continue
        rid = id_match.group(1).strip()
        title_match = re.search(r'^title:\s*"?(.*?)"?\s*$', fm, re.MULTILINE | re.DOTALL)
        url_match = re.search(r'^url:\s*(\S+)', fm, re.MULTILINE)
        out[rid] = {
            "title": title_match.group(1).strip().strip('"') if title_match else "",
            "url": url_match.group(1).strip() if url_match else "",
        }
    return out


def build_items():
    """Compute the 34 ensemble-wrong items with full metadata."""
    results = json.load(open(RESULTS_PATH))
    descriptions = json.load(open(DESC_PATH))
    cache = json.load(open(CACHE_PATH))
    vault = load_vault_titles()

    A = {p["id"]: p for p in results["gemma4:e4b/T1_letter/k5-hardneg"]["picks"]}  # K=5 T1
    B = {p["id"]: p for p in results["gemma4:e4b/T2_json/k7-hardneg"]["picks"]}    # K=7 T2

    def rank_in(p, topk):
        return topk.index(p) if p in topk else 99

    items = []
    for iid in A.keys():
        a = A[iid]
        b = B[iid]
        gt = a["gt"]
        a_pick = a.get("picked_coll")
        b_pick = b.get("picked_coll")
        b_topk = b["topk"]

        if a_pick == b_pick:
            final = a_pick
            tiebreak = "agree"
        else:
            final = a_pick if rank_in(a_pick, b_topk) < rank_in(b_pick, b_topk) else b_pick
            tiebreak = "a_wins" if final == a_pick else "b_wins"

        if final == gt:
            continue  # correct — skip

        entry = cache.get(iid, {}) or {}
        vmeta = vault.get(iid, {}) or {}
        # Local media for tiktok items — either video.mp4 or numbered slideshow jpgs
        media_type = None  # "video" | "slideshow" | None
        slide_count = 0
        if iid.startswith("tiktok:"):
            num = iid.split(":", 1)[1]
            folder = VAULT / "Bookmarks" / "TikTok" / f"tiktok-{num}"
            if (folder / "video.mp4").exists():
                media_type = "video"
            else:
                slides = sorted(folder.glob("[0-9]*.jpg"),
                                key=lambda p: int(p.stem) if p.stem.isdigit() else 9999)
                slides = [p for p in slides if p.stem.isdigit()]
                if slides:
                    media_type = "slideshow"
                    slide_count = len(slides)
        items.append({
            "id": iid,
            "media_type": media_type,
            "slide_count": slide_count,
            "title": vmeta.get("title", ""),
            "url": vmeta.get("url", ""),
            "summary": entry.get("summary") or "",
            "vision": (entry.get("vision") or "")[:1200],
            "predicted_category": entry.get("category") or "",
            "gt": gt,
            "gt_desc": descriptions.get(gt, ""),
            "ensemble_pick": final,
            "ensemble_pick_desc": descriptions.get(final, "") if final else "",
            "a_pick": a_pick,
            "b_pick": b_pick,
            "tiebreak": tiebreak,
            "topk_k7": b_topk,
            "topk_k7_descs": {c: descriptions.get(c, "") for c in b_topk if c != "(none)"},
            "gt_in_topk7": gt in b_topk,
        })
    return items


def load_prior_audits():
    """Return {id: latest category/notes/audited_at} from existing JSONL."""
    if not LOG_PATH.exists():
        return {}
    out = {}
    for line in LOG_PATH.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
            out[rec["id"]] = {
                "category": rec.get("category"),
                "notes": rec.get("notes", ""),
                "audited_at": rec.get("audited_at"),
            }
        except Exception:
            pass
    return out


INDEX_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Failure Audit — Roost 85/119</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #0e0e10; color: #e8e8ea; }
  h1 { margin: 0 0 4px; font-size: 18px; }
  .progress-bar { height: 6px; background: #26262a; border-radius: 3px; overflow: hidden; margin: 12px 0 20px; }
  .progress-fill { height: 100%; background: linear-gradient(90deg, #4f8bff, #a26bff); transition: width .2s; }
  .meta { color: #8a8a93; font-size: 12px; }
  .card { background: #1a1a1e; border: 1px solid #2a2a30; border-radius: 10px; padding: 20px; margin-bottom: 16px; }
  .title { font-size: 15px; font-weight: 600; line-height: 1.4; margin-bottom: 8px; }
  .summary { font-size: 14px; color: #d0d0d6; margin-bottom: 10px; }
  .vision { font-size: 12px; color: #9a9aa3; max-height: 140px; overflow-y: auto; padding: 8px; background: #0e0e10; border-radius: 6px; border: 1px solid #26262a; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; background: #2a2a30; color: #a0a0a8; margin-right: 6px; }
  .video-wrap { margin: 10px 0 14px; display: flex; justify-content: center; background: #000; border-radius: 8px; overflow: hidden; }
  .video-wrap video { max-height: 360px; max-width: 100%; display: block; }
  .slides-wrap { margin: 10px 0 14px; display: flex; gap: 8px; overflow-x: auto; padding: 8px; background: #000; border-radius: 8px; }
  .slides-wrap img { max-height: 300px; border-radius: 4px; display: block; }
  .vs { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 8px; }
  .box { padding: 12px; border-radius: 8px; border: 1px solid; }
  .box-gt { background: rgba(40, 180, 100, 0.08); border-color: rgba(40, 180, 100, 0.4); }
  .box-pick { background: rgba(255, 100, 100, 0.08); border-color: rgba(255, 100, 100, 0.4); }
  .box h3 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #b0b0b8; }
  .box .name { font-size: 16px; font-weight: 700; margin-bottom: 6px; }
  .box .desc { font-size: 12px; color: #c0c0c6; line-height: 1.5; }
  .topk { font-size: 11px; color: #7a7a83; margin-top: 12px; }
  .topk b { color: #a0a0a8; }
  details { font-size: 11px; color: #7a7a83; margin-top: 6px; }
  details summary { cursor: pointer; }
  .cat-buttons { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 12px 0; }
  .cat-btn { padding: 14px 10px; border-radius: 8px; border: 2px solid #2a2a30; background: #1a1a1e; color: #e8e8ea; cursor: pointer; font-size: 13px; font-weight: 600; text-align: center; transition: all .15s; }
  .cat-btn:hover { border-color: #4f8bff; }
  .cat-btn.selected { background: #4f8bff; border-color: #4f8bff; color: white; }
  .cat-btn .hint { display: block; font-size: 10px; font-weight: 400; color: #9a9aa3; margin-top: 3px; }
  .cat-btn.selected .hint { color: rgba(255,255,255,0.85); }
  textarea { width: 100%; min-height: 60px; padding: 10px; border-radius: 6px; border: 1px solid #2a2a30; background: #0e0e10; color: #e8e8ea; font-family: inherit; font-size: 13px; resize: vertical; }
  .nav { display: flex; gap: 8px; justify-content: space-between; align-items: center; margin-top: 16px; }
  .nav button { padding: 10px 18px; border-radius: 6px; border: 1px solid #2a2a30; background: #1a1a1e; color: #e8e8ea; cursor: pointer; font-size: 13px; font-weight: 600; }
  .nav button:hover:not(:disabled) { background: #26262a; }
  .nav button.primary { background: #4f8bff; border-color: #4f8bff; color: white; }
  .nav button.primary:hover { background: #3b7aff; }
  .nav button:disabled { opacity: 0.4; cursor: not-allowed; }
  .tally { display: flex; gap: 16px; margin-top: 20px; padding: 14px; background: #1a1a1e; border-radius: 8px; border: 1px solid #2a2a30; font-size: 12px; }
  .tally div { color: #a0a0a8; }
  .tally b { color: #e8e8ea; }
  a { color: #4f8bff; }
  .url-link { font-size: 11px; }
  .saved { color: #4ade80; font-size: 11px; }
  .unsaved { color: #fbbf24; font-size: 11px; }
</style>
</head>
<body>
  <h1>Failure Audit — Roost 85/119 SOTA</h1>
  <div class="meta">
    Classifying 34 ensemble-wrong items. Categories: <b>ambiguous</b> = both valid,
    <b>mislabeled</b> = data error, <b>reasoning_gap</b> = model wrong, <b>unclear</b> = can't tell.
    Log: <code>.roost/failure-audit-log.jsonl</code>
  </div>

  <div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>

  <div id="app"></div>

  <div class="tally" id="tally"></div>

<script>
const ITEMS = __ITEMS__;
const PRIOR = __PRIOR__;
let idx = 0;
let state = {};
ITEMS.forEach(it => {
  const p = PRIOR[it.id];
  state[it.id] = { category: p ? p.category : null, notes: p ? p.notes : "", saved: !!p };
});

function render() {
  const it = ITEMS[idx];
  const s = state[it.id];
  const pct = ((idx + 1) / ITEMS.length) * 100;
  document.getElementById("progress-fill").style.width = pct + "%";

  const topk = it.topk_k7.filter(x => x !== "(none)")
    .map((c, i) => {
      let tag = "";
      if (c === it.gt) tag = ' <span class="pill" style="background:#1f6f3f;color:#8ef0a8">GT</span>';
      else if (c === it.ensemble_pick) tag = ' <span class="pill" style="background:#6f1f1f;color:#f08e8e">PICK</span>';
      return `<div>${i+1}. ${escapeHtml(c)}${tag}</div>`;
    }).join("");

  const saveStatus = s.saved
    ? `<span class="saved">● saved</span>`
    : (s.category ? `<span class="unsaved">● unsaved — press Save</span>` : `<span class="meta">not yet classified</span>`);

  document.getElementById("app").innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div class="meta">Item ${idx+1}/${ITEMS.length} — <code>${escapeHtml(it.id)}</code> — ${saveStatus}</div>
        ${it.url ? `<a class="url-link" target="_blank" href="${escapeHtml(it.url)}">open source ↗</a>` : ""}
      </div>
      <div class="title">${escapeHtml(it.title || "(no title)")}</div>
      ${renderMedia(it)}
      <div class="summary"><b>Summary:</b> ${escapeHtml(it.summary || "(none)")}</div>
      ${it.predicted_category ? `<div class="meta" style="margin-bottom:8px"><span class="pill">predicted category: ${escapeHtml(it.predicted_category)}</span></div>` : ""}
      <details><summary>Vision description</summary><div class="vision">${escapeHtml(it.vision || "(none)")}</div></details>

      <div class="vs" style="margin-top:12px">
        <div class="box box-gt">
          <h3>Ground Truth</h3>
          <div class="name">${escapeHtml(it.gt)}</div>
          <div class="desc">${escapeHtml(it.gt_desc || "(no description)")}</div>
        </div>
        <div class="box box-pick">
          <h3>Ensemble Pick (wrong)</h3>
          <div class="name">${escapeHtml(it.ensemble_pick || "(none)")}</div>
          <div class="desc">${escapeHtml(it.ensemble_pick_desc || "(no description)")}</div>
        </div>
      </div>

      <div class="topk">
        <b>K=7 topk</b> (GT ${it.gt_in_topk7 ? "✓ present" : "✗ NOT in topk"}; tiebreak: ${it.tiebreak}; k5/T1 pick: ${escapeHtml(it.a_pick || "∅")}, k7/T2 pick: ${escapeHtml(it.b_pick || "∅")})<br>
        ${topk}
      </div>
    </div>

    <div class="card">
      <div class="cat-buttons">
        <button class="cat-btn ${s.category==='ambiguous'?'selected':''}" onclick="setCat('ambiguous')">
          Ambiguous <span class="hint">both valid</span>
        </button>
        <button class="cat-btn ${s.category==='mislabeled'?'selected':''}" onclick="setCat('mislabeled')">
          Mislabeled <span class="hint">data error</span>
        </button>
        <button class="cat-btn ${s.category==='reasoning_gap'?'selected':''}" onclick="setCat('reasoning_gap')">
          Reasoning gap <span class="hint">model wrong</span>
        </button>
        <button class="cat-btn ${s.category==='unclear'?'selected':''}" onclick="setCat('unclear')">
          Unclear <span class="hint">need more info</span>
        </button>
      </div>
      <textarea id="notes" placeholder="Optional notes — why is this ambiguous? what's the real category?" oninput="setNotes(this.value)">${escapeHtml(s.notes || "")}</textarea>
      <div class="nav">
        <button onclick="prev()" ${idx===0?'disabled':''}>← Prev</button>
        <button class="primary" onclick="saveAndNext()" ${s.category?'':'disabled'}>Save &amp; Next →</button>
        <button onclick="next()" ${idx===ITEMS.length-1?'disabled':''}>Skip →</button>
      </div>
    </div>
  `;
  renderTally();
}

function renderTally() {
  const counts = { ambiguous:0, mislabeled:0, reasoning_gap:0, unclear:0, unclassified:0 };
  for (const it of ITEMS) {
    const s = state[it.id];
    if (s.category && s.saved) counts[s.category]++;
    else counts.unclassified++;
  }
  document.getElementById("tally").innerHTML = `
    <div>Ambiguous: <b>${counts.ambiguous}</b></div>
    <div>Mislabeled: <b>${counts.mislabeled}</b></div>
    <div>Reasoning gap: <b>${counts.reasoning_gap}</b></div>
    <div>Unclear: <b>${counts.unclear}</b></div>
    <div style="margin-left:auto">Remaining: <b>${counts.unclassified}</b>/${ITEMS.length}</div>
  `;
}

function setCat(c) {
  const it = ITEMS[idx];
  state[it.id].category = c;
  state[it.id].saved = false;
  render();
}

function setNotes(v) {
  const it = ITEMS[idx];
  if (state[it.id].notes !== v) {
    state[it.id].notes = v;
    state[it.id].saved = false;
  }
}

async function saveAndNext() {
  const it = ITEMS[idx];
  const s = state[it.id];
  if (!s.category) return;
  const payload = {
    id: it.id,
    gt: it.gt,
    ensemble_pick: it.ensemble_pick,
    category: s.category,
    notes: s.notes || "",
  };
  try {
    const r = await fetch("/submit", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload) });
    if (r.ok) {
      state[it.id].saved = true;
      if (idx < ITEMS.length - 1) { idx++; }
      render();
    } else {
      alert("Save failed: " + r.status);
    }
  } catch (e) {
    alert("Save error: " + e.message);
  }
}

function prev() { if (idx > 0) { idx--; render(); } }
function next() { if (idx < ITEMS.length - 1) { idx++; render(); } }

function renderMedia(it) {
  if (it.media_type === "video") {
    return `<div class="video-wrap"><video controls preload="metadata" playsinline src="/video/${encodeURIComponent(it.id)}"></video></div>`;
  }
  if (it.media_type === "slideshow") {
    const imgs = [];
    for (let i = 1; i <= it.slide_count; i++) {
      imgs.push(`<img loading="lazy" src="/image/${encodeURIComponent(it.id)}/${i}" alt="slide ${i}">`);
    }
    return `<div class="slides-wrap">${imgs.join("")}</div>`;
  }
  return "";
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

document.addEventListener("keydown", e => {
  if (e.target.tagName === "TEXTAREA") return;
  if (e.key === "ArrowLeft") prev();
  else if (e.key === "ArrowRight") next();
  else if (e.key === "1") setCat("ambiguous");
  else if (e.key === "2") setCat("mislabeled");
  else if (e.key === "3") setCat("reasoning_gap");
  else if (e.key === "4") setCat("unclear");
  else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveAndNext();
});

render();
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    items_json = ""
    prior_json = "{}"

    def log_message(self, fmt, *args):  # silence default access log
        pass

    def do_GET(self):
        if self.path == "/" or self.path == "/index.html":
            html = INDEX_HTML.replace("__ITEMS__", Handler.items_json).replace("__PRIOR__", Handler.prior_json)
            body = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/video/"):
            from urllib.parse import unquote
            iid = unquote(self.path[len("/video/"):])
            if not iid.startswith("tiktok:"):
                self.send_error(404, "only tiktok supported")
                return
            num = iid.split(":", 1)[1]
            if not num.isdigit():
                self.send_error(400, "bad id")
                return
            path = VAULT / "Bookmarks" / "TikTok" / f"tiktok-{num}" / "video.mp4"
            if not path.exists():
                self.send_error(404, "video not found")
                return
            self._serve_file_with_range(path, "video/mp4")
            return
        if self.path.startswith("/image/"):
            from urllib.parse import unquote
            rest = unquote(self.path[len("/image/"):])
            if "/" not in rest:
                self.send_error(400, "bad image path")
                return
            iid, n = rest.rsplit("/", 1)
            if not iid.startswith("tiktok:") or not n.isdigit():
                self.send_error(400, "bad image path")
                return
            num = iid.split(":", 1)[1]
            if not num.isdigit():
                self.send_error(400, "bad id")
                return
            path = VAULT / "Bookmarks" / "TikTok" / f"tiktok-{num}" / f"{int(n)}.jpg"
            if not path.exists():
                self.send_error(404, "image not found")
                return
            self._serve_file_with_range(path, "image/jpeg")
            return
        self.send_error(404)

    def _serve_file_with_range(self, path, content_type):
        """Serve a file honoring HTTP Range requests (required for mp4 scrubbing)."""
        size = os.path.getsize(path)
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        is_range = False
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                s, e = m.group(1), m.group(2)
                if s:
                    start = int(s)
                if e:
                    end = int(e)
                if start > end or end >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.end_headers()
                    return
                is_range = True
        length = end - start + 1
        self.send_response(206 if is_range else 200)
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if is_range:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        try:
            with open(path, "rb") as f:
                f.seek(start)
                remaining = length
                chunk = 64 * 1024
                while remaining > 0:
                    buf = f.read(min(chunk, remaining))
                    if not buf:
                        break
                    self.wfile.write(buf)
                    remaining -= len(buf)
        except (BrokenPipeError, ConnectionResetError):
            pass  # client aborted (seek/close) — harmless

    def do_POST(self):
        if self.path != "/submit":
            self.send_error(404)
            return
        n = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(n)
        try:
            payload = json.loads(raw)
        except Exception as e:
            self.send_error(400, f"bad json: {e}")
            return
        if not payload.get("id") or not payload.get("category"):
            self.send_error(400, "missing id/category")
            return
        rec = {
            "id": payload["id"],
            "gt": payload.get("gt"),
            "ensemble_pick": payload.get("ensemble_pick"),
            "category": payload["category"],
            "notes": payload.get("notes", ""),
            "audited_at": datetime.now().isoformat(timespec="seconds"),
        }
        with open(LOG_PATH, "a") as f:
            f.write(json.dumps(rec) + "\n")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')


def main():
    items = build_items()
    prior = load_prior_audits()
    Handler.items_json = json.dumps(items)
    Handler.prior_json = json.dumps(prior)

    print(f"Audit dashboard — {len(items)} wrong items")
    print(f"Log: {LOG_PATH}")
    print(f"Prior audits loaded: {len(prior)}")
    print(f"\n  →  open http://localhost:{PORT}\n")
    print("Keyboard: 1=ambiguous 2=mislabeled 3=reasoning_gap 4=unclear  ←/→=nav  ⌘+Enter=save")
    print("Press Ctrl+C to stop.\n")

    srv = HTTPServer(("127.0.0.1", PORT), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
