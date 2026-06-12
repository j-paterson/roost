#!/usr/bin/env bash
#
# Roost — one-command setup for the local AI integrations.
#
#   ./scripts/setup-integrations.sh --vault-root /path/to/your/Obsidian/vault
#
# Installs + starts Ollama and pulls the models Roost uses, then (optionally)
# sets up and starts the embedding sidecar. Safe to re-run — every step is
# skipped if it's already done.
#
#   --vault-root <path>   Vault root (or set ROOST_VAULT). Needed for the sidecar.
#   --skip-sidecar        Set up Ollama only (enough for most users).
#   -h, --help            Show this help.
#
set -euo pipefail

VAULT_ROOT="${ROOST_VAULT:-}"
SKIP_SIDECAR=0
while [ $# -gt 0 ]; do
  case "$1" in
    --vault-root) VAULT_ROOT="${2:-}"; shift 2 ;;
    --skip-sidecar) SKIP_SIDECAR=1; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1 (try --help)"; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OS="$(uname -s)"
say()  { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
ok()   { printf "  \033[1;32m✓ %s\033[0m\n" "$*"; }
warn() { printf "  \033[1;33m! %s\033[0m\n" "$*"; }

ollama_up()  { curl -fsS --max-time 3 http://localhost:11434/api/tags >/dev/null 2>&1; }
sidecar_up() { curl -fsS --max-time 3 http://localhost:11435/api/tags >/dev/null 2>&1; }

# ───────────────────────────── 1. Ollama ─────────────────────────────
say "Ollama (LLM + base embeddings)"

if ! command -v ollama >/dev/null 2>&1; then
  if [ "$OS" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    say "Installing Ollama via Homebrew…"; brew install ollama
  elif [ "$OS" = "Linux" ]; then
    say "Installing Ollama…"; curl -fsSL https://ollama.com/install.sh | sh
  else
    warn "Couldn't auto-install. Download Ollama from https://ollama.com/download, then re-run this script."
    exit 1
  fi
fi
ok "Ollama installed ($(ollama --version 2>/dev/null | head -1 | tr -d '\r'))"

if ! ollama_up; then
  say "Starting the Ollama server…"
  if [ "$OS" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    brew services start ollama >/dev/null 2>&1 || nohup ollama serve >/tmp/roost-ollama.log 2>&1 &
  else
    nohup ollama serve >/tmp/roost-ollama.log 2>&1 &
  fi
  for _ in $(seq 1 30); do ollama_up && break; sleep 1; done
fi
ollama_up && ok "Ollama is serving on :11434" || warn "Ollama didn't come up — run 'ollama serve' yourself (log: /tmp/roost-ollama.log)."

# Models Roost uses (see packages/core/src/config.ts).
for m in nomic-embed-text llama3.2:3b gemma4:e4b; do
  if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$m"; then
    ok "model ready: $m"
  else
    say "Pulling $m …"
    ollama pull "$m" && ok "pulled $m" || warn "Could not pull '$m' — check the model name and pull it manually."
  fi
done

# ─────────────────────────── 2. Embedding sidecar ───────────────────────────
if [ "$SKIP_SIDECAR" = "1" ]; then
  say "Skipping the sidecar (--skip-sidecar). Ollama alone covers embeddings + chat — you're done."
  exit 0
fi

say "Embedding sidecar (optional — fine-tuned embeddings on :11435)"
if [ -z "$VAULT_ROOT" ]; then
  warn "The sidecar needs your vault path. Re-run with --vault-root /path/to/vault (or set ROOST_VAULT). Skipping for now."
  warn "That's fine — Ollama already provides embeddings; the sidecar is an optional upgrade."
  exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
  warn "python3 not found — install Python 3, then re-run. Skipping the sidecar."
  exit 0
fi

VENV="$SCRIPT_DIR/.venv"
if [ ! -d "$VENV" ]; then say "Creating Python venv…"; python3 -m venv "$VENV"; fi
say "Installing sidecar dependencies (downloads PyTorch — a few minutes the first time)…"
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q -r "$SCRIPT_DIR/requirements.txt"
ok "Sidecar dependencies installed"

if sidecar_up; then
  ok "Sidecar already running on :11435"
else
  say "Starting the sidecar…"
  nohup "$VENV/bin/python" "$SCRIPT_DIR/embed-sidecar.py" --vault-root "$VAULT_ROOT" >/tmp/roost-sidecar.log 2>&1 &
  for _ in $(seq 1 90); do sidecar_up && break; sleep 1; done
  sidecar_up && ok "Sidecar is serving on :11435" || warn "Sidecar didn't come up — check /tmp/roost-sidecar.log"
fi

say "Done. Reopen Roost's settings — Integrations should show Ollama (and the sidecar) as detected."
echo "  • Logs:  /tmp/roost-ollama.log   /tmp/roost-sidecar.log"
echo "  • To keep the sidecar running after a reboot, add a launchd/systemd unit (see scripts/README or docs)."
