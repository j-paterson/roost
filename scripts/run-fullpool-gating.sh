#!/bin/bash
# Full-pool caption-gating eval driver — two-phase staged, runs unattended under caffeinate.
# Phase A (sidecar DOWN): qwen-describe every pool cover for TikTok (~2.4K) + Twitter (~1.8K). Resumable.
# Phase B (sidecar UP):   embed empty-vs-cover + gradient/gated/McNemar/per-category, save results.
set -u
export ROOST_VAULT="/Users/josystem/SynologyDrive/SynologyDrive/ObsidianBookmarks"
PY="$ROOST_VAULT/.roost/venv/bin/python3"
cd /Users/josystem/Projects/roost/scripts
OUT="$ROOST_VAULT/.roost/cache/fullpool-gating-results"
mkdir -p "$OUT"
log(){ echo "[$(date +%H:%M:%S)] $*"; }
SIDECAR_PLIST="$HOME/Library/LaunchAgents/com.roost.embed-sidecar.plist"
UID_N=$(id -u)

log "=== PHASE A: DESCRIBE (sidecar must be down) ==="
launchctl bootout "gui/$UID_N/com.roost.embed-sidecar" 2>/dev/null
sleep 2
log "describing TikTok pool ..."
$PY exp-tiktok-gating.py --phase describe   > "$OUT/describe-tiktok.log" 2>&1
log "describing Twitter pool ..."
$PY exp-twitter-gating.py --phase describe  > "$OUT/describe-twitter.log" 2>&1
log "describe phase done."

log "=== bringing embed sidecar UP ==="
launchctl bootstrap "gui/$UID_N" "$SIDECAR_PLIST" 2>/dev/null
for i in $(seq 1 30); do
  if curl -s -m 3 http://localhost:11435/api/embed -d '{"model":"x","input":["ping"]}' >/dev/null 2>&1; then
    log "sidecar is up."; break; fi
  sleep 2
done

log "=== PHASE B: EMBED + ANALYZE (sidecar up) ==="
$PY -W ignore exp-tiktok-gating.py  --phase embed > "$OUT/results-tiktok.txt"  2>/dev/null
log "tiktok embed/analyze done -> results-tiktok.txt"
$PY -W ignore exp-twitter-gating.py --phase embed > "$OUT/results-twitter.txt" 2>/dev/null
log "twitter embed/analyze done -> results-twitter.txt"
log "=== ALL DONE ==="
