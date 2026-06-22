#!/usr/bin/env bash
# Vision-stacking operational rollout orchestrator.
#
# Drives the automatable tail end-to-end, unattended and resumable:
#   PHASE 1  describe : wait for the running qwen cover describe to finish; resume
#                       it (sidecar DOWN) if it died, until nothing is left to do.
#   PHASE 2  embed    : bring the sidecar UP, rewrite embedding-cache.json + both
#                       bins to the qwen cover-only representation (backs up first).
#   PHASE 3  deploy   : vite build + copy main.js into the vault plugin dir so the
#                       committed smartAssignStacking=true default goes live.
#   PHASE 4  activate : relaunch Obsidian so the new build loads.
#
# NOT automated (UI-only, intentionally): the final Smart Assign re-score of
# existing autos — its write-back (confirm.ts: tags/subcats/provenance) is not
# safe to reproduce headlessly. Do it with one click in the Roost view afterward.
#
# Idempotent: safe to re-run after a reboot — it resumes describe / re-embeds /
# re-deploys as needed. Run detached:
#   nohup caffeinate -is bash scripts/run-rollout.sh >/dev/null 2>&1 < /dev/null &
set -u

export ROOST_VAULT=/Users/josystem/SynologyDrive/SynologyDrive/ObsidianBookmarks
export ROOST_DEV_VAULT="$ROOST_VAULT"
REPO=/Users/josystem/Projects/roost
C="$ROOST_VAULT/.roost/cache"
PY="$ROOST_VAULT/.roost/venv/bin/python3"
NODE_BIN=/Users/josystem/.local/share/fnm/node-versions/v20.20.0/installation/bin
export PATH="$NODE_BIN:$PATH"
SIDE_PLIST="$HOME/Library/LaunchAgents/com.roost.embed-sidecar.plist"
LOG="$C/rollout-orchestrator.log"
DONE="$C/rollout.DONE"

exec >> "$LOG" 2>&1
log(){ echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

if [ -f "$DONE" ]; then log "rollout.DONE present — nothing to do. Remove it to force a re-run."; exit 0; fi
cd "$REPO" || { log "FATAL: repo $REPO missing"; exit 1; }
log "=== ROLLOUT ORCHESTRATOR START (pid $$) ==="

# ── PHASE 1: describe ─────────────────────────────────────────────────────────
log "PHASE 1: waiting for qwen cover describe (sidecar stays DOWN)"
while pgrep -f "rebuild-production-embeddings.py --phase describe" >/dev/null; do sleep 120; done
while :; do
  todo=$($PY scripts/rebuild-production-embeddings.py --check-todo 2>/dev/null | tail -1)
  if [ "${todo:-x}" = "0" ]; then log "describe complete (todo=0)"; break; fi
  log "describe not finished (todo=${todo:-?}) — resuming"
  caffeinate -is "$PY" -u scripts/rebuild-production-embeddings.py --phase describe
done

# ── PHASE 2: sidecar UP + embed ───────────────────────────────────────────────
log "PHASE 2: bringing embed sidecar UP"
launchctl bootstrap "gui/$(id -u)" "$SIDE_PLIST" 2>&1 || launchctl kickstart "gui/$(id -u)/com.roost.embed-sidecar" 2>&1
up=0
for _ in $(seq 1 40); do
  if curl -s -m4 http://localhost:11435/api/embed -H 'Content-Type: application/json' \
       -d '{"model":"x","input":["ping"]}' >/dev/null 2>&1; then up=1; break; fi
  sleep 3
done
[ "$up" = 1 ] && log "sidecar UP" || { log "FATAL: sidecar did not come up"; exit 1; }
log "PHASE 2: embed (rewrites cache + bins; backs up to *.PRE-QWEN-REBUILD)"
caffeinate -is "$PY" -u scripts/rebuild-production-embeddings.py --phase embed || { log "FATAL: embed phase failed"; exit 1; }
log "embed complete"

# ── PHASE 3: build + deploy ───────────────────────────────────────────────────
log "PHASE 3: vite build + deploy to vault plugin dir"
if "$NODE_BIN/npm" run install:vault; then
  log "deploy OK"
else
  log "FATAL: build/deploy failed"; exit 1
fi

# ── PHASE 4: activate ─────────────────────────────────────────────────────────
log "PHASE 4: relaunching Obsidian to load the new build"
osascript -e 'tell application "Obsidian" to quit' 2>/dev/null || true
sleep 5
open -a Obsidian 2>/dev/null || log "note: could not auto-open Obsidian — open it manually"

log "=== DATA + DEPLOY COMPLETE — stacking is live for future Smart Assign runs ==="
log "REMAINING (manual, UI-only): Roost view -> Smart Assign -> confirm, to re-score existing autos through the stacked path (human assignments untouched)."
touch "$DONE"
log "=== ROLLOUT ORCHESTRATOR DONE ==="
