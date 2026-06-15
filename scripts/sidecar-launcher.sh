#!/bin/sh
# Roost embedding + ASR sidecar launcher. On macOS install-sidecar-service.sh
# copies this file into RoostSidecar.app/Contents/MacOS/RoostSidecar and the
# LaunchAgent runs it as the bundle executable, so the Login Items / "Allow in
# the Background" UI shows "RoostSidecar" rather than "sh". The LaunchAgent
# passes ROOST_SCRIPTS_DIR (authoritative for locating the .venv on the vault).
# NO-OPS cleanly (exit 0) when the sidecar isn't set up, so launchd's KeepAlive
# never crash-loops on a fresh machine / Ollama-only project.
set -u
ts() { date '+%H:%M:%S'; }

# Scripts dir: the LaunchAgent passes ROOST_SCRIPTS_DIR; fall back to deriving
# it from this file's location when run directly.
SCRIPTS_DIR="${ROOST_SCRIPTS_DIR:-}"
if [ -z "$SCRIPTS_DIR" ]; then
  SCRIPTS_DIR=$(cd "$(dirname "$0")/../../.." 2>/dev/null && pwd || true)
fi
VENV_PY="$SCRIPTS_DIR/.venv/bin/python"
SIDECAR="$SCRIPTS_DIR/embed-sidecar.py"
VAULT_ROOT="${ROOST_VAULT:-}"

if [ -z "$SCRIPTS_DIR" ] || [ ! -x "$VENV_PY" ]; then
  echo "$(ts) roost-sidecar: no venv at $VENV_PY — not set up; skipping (run setup-integrations.sh)."
  exit 0
fi
if [ ! -f "$SIDECAR" ]; then
  echo "$(ts) roost-sidecar: no embed-sidecar.py in $SCRIPTS_DIR — skipping."
  exit 0
fi
if [ -z "$VAULT_ROOT" ]; then
  echo "$(ts) roost-sidecar: ROOST_VAULT not set — skipping."
  exit 0
fi
if curl -s --max-time 2 "http://127.0.0.1:11435/health" >/dev/null 2>&1; then
  echo "$(ts) roost-sidecar: already serving on :11435 — nothing to do."
  exit 0
fi
echo "$(ts) roost-sidecar: starting $VENV_PY (vault=$VAULT_ROOT)"
exec "$VENV_PY" "$SIDECAR" --vault-root "$VAULT_ROOT"
