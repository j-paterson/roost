#!/usr/bin/env bash
#
# Roost — one-command setup for the local AI integrations.
#
#   ./scripts/setup-integrations.sh --vault-root /path/to/your/Obsidian/vault
#
# Installs + starts Ollama, brings base embeddings (nomic-embed-text) up first,
# then runs the two slow phases CONCURRENTLY: pulling the large chat models and
# setting up + starting the embedding sidecar. Safe to re-run — every step is
# skipped if it's already done.
#
#   --vault-root <path>   Vault root (or set ROOST_VAULT). Needed for the sidecar.
#   --skip-sidecar        Set up Ollama only (enough for most users).
#   --skip-autostart      Set up the sidecar but don't install the auto-start
#                         service (run it only for this session).
#   -h, --help            Show this help.
#
set -euo pipefail

VAULT_ROOT="${ROOST_VAULT:-}"
SKIP_SIDECAR=0
SKIP_AUTOSTART=0
while [ $# -gt 0 ]; do
  case "$1" in
    --vault-root)
      if [ $# -lt 2 ]; then echo "Error: --vault-root needs a path (try --help)"; exit 1; fi
      VAULT_ROOT="$2"; shift 2 ;;
    --skip-sidecar) SKIP_SIDECAR=1; shift ;;
    --skip-autostart) SKIP_AUTOSTART=1; shift ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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

# Resolve a usable `uv` into $UV. uv lets us build the sidecar venv against a
# STANDALONE Python (not Homebrew's), so it survives `brew upgrade`. Installs uv
# via the official script if it's missing. Leaves $UV empty if uv is still not
# runnable (the sidecar phase then falls back to `python3 -m venv`).
UV=""
ensure_uv() {
  if ! command -v uv >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/uv" ]; then
    say "Installing uv (fast Python venv/package manager)…"
    curl -LsSf https://astral.sh/uv/install.sh | sh || warn "uv install script failed — falling back to python3 -m venv."
  fi
  UV="$(command -v uv 2>/dev/null || echo "$HOME/.local/bin/uv")"
  if [ ! -x "$UV" ] && ! command -v "$UV" >/dev/null 2>&1; then
    UV=""
  fi
}

# Log files — each concurrent phase gets its OWN file so output never
# interleaves. The sidecar has two: one for the (foreground-to-the-job) setup
# progress, and a separate one for the long-lived detached server's runtime
# output, so setup status and server logs don't share a file.
OLLAMA_LOG=/tmp/roost-ollama.log
CHAT_LOG=/tmp/roost-chat-models.log
SIDECAR_SETUP_LOG=/tmp/roost-sidecar-setup.log
SIDECAR_LOG=/tmp/roost-sidecar.log

# True if model "$1" is already present in `ollama list`. The NAME column shows
# the full tag (e.g. "nomic-embed-text:latest", "llama3.2:3b"), so we match the
# requested name either exactly OR as "<name>:<tag>". awk does a LITERAL field
# compare (no regex), so dots/colons in model names never act as metacharacters.
model_present() {
  ollama list 2>/dev/null | awk -v want="$1" '
    NR > 1 {
      name = $1
      if (name == want) { found = 1; exit }
      n = length(want)
      if (substr(name, 1, n) == want && substr(name, n + 1, 1) == ":") { found = 1; exit }
    }
    END { exit (found ? 0 : 1) }
  '
}

# Pull model "$1" if missing. Echoes a status line into the current job's log.
# Returns non-zero only on a real pull failure.
pull_model() {
  if model_present "$1"; then
    echo "model ready: $1"
    return 0
  fi
  echo "Pulling $1 …"
  if ollama pull "$1"; then
    echo "pulled $1"
    return 0
  fi
  echo "Could not pull '$1' — check the model name and pull it manually."
  return 1
}

# ───────────────────────────── 1. Ollama ─────────────────────────────
say "Ollama (LLM + base embeddings)"

OLLAMA_OK=0
if ! command -v ollama >/dev/null 2>&1; then
  if [ "$OS" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    say "Installing Ollama via Homebrew…"
    brew install ollama || warn "Homebrew install of Ollama failed — see https://ollama.com/download"
  elif [ "$OS" = "Linux" ]; then
    say "Installing Ollama…"
    curl -fsSL https://ollama.com/install.sh | sh || warn "Ollama install script failed — see https://ollama.com/download"
  else
    warn "Couldn't auto-install. Download Ollama from https://ollama.com/download, then re-run this script."
  fi
fi

if command -v ollama >/dev/null 2>&1; then
  ok "Ollama installed ($(ollama --version 2>/dev/null | head -1 | tr -d '\r'))"

  if ! ollama_up; then
    say "Starting the Ollama server…"
    if [ "$OS" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
      brew services start ollama >/dev/null 2>&1 || nohup ollama serve >"$OLLAMA_LOG" 2>&1 &
    else
      nohup ollama serve >"$OLLAMA_LOG" 2>&1 &
    fi
    for _ in $(seq 1 30); do ollama_up && break; sleep 1; done
  fi

  if ollama_up; then
    ok "Ollama is serving on :11434"
    OLLAMA_OK=1
  else
    warn "Ollama didn't come up — run 'ollama serve' yourself (log: $OLLAMA_LOG)."
  fi
else
  warn "Ollama isn't available — skipping all Ollama steps. The sidecar (if requested) is independent and will still be attempted."
fi

# Bring base embeddings up FIRST so the Integrations panel flips to detected fast
# (Roost's default embeddings use nomic-embed-text). Small model, quick pull.
EMBED_OK=0
if [ "$OLLAMA_OK" = "1" ]; then
  say "Pulling base embeddings model (nomic-embed-text) so embeddings come up fast…"
  if pull_model nomic-embed-text; then
    ok "Ollama embeddings ready (nomic-embed-text on :11434)"
    EMBED_OK=1
  else
    warn "nomic-embed-text didn't pull — embeddings won't work until it's present."
  fi
fi

# ─────────────────── 2. Slow phases, run CONCURRENTLY ───────────────────
# Phase A: pull the large chat models.
# Phase B: full sidecar setup (venv + pip + launch + poll).
# Neither blocks the other; we wait for both and summarize at the end. Each
# phase runs as a single background job writing only to its own log; each job's
# exit status is harvested with `wait <pid>` so a non-zero exit is surfaced in
# the summary — never swallowed, and never aborts this script under set -e.

# ---- decide whether the sidecar phase should run at all ----
SIDECAR_REQUESTED=0
SIDECAR_SKIP_REASON=""
if [ "$SKIP_SIDECAR" = "1" ]; then
  SIDECAR_SKIP_REASON="--skip-sidecar set"
elif [ -z "$VAULT_ROOT" ]; then
  SIDECAR_SKIP_REASON="no vault path (pass --vault-root /path/to/vault or set ROOST_VAULT)"
elif ! command -v python3 >/dev/null 2>&1; then
  SIDECAR_SKIP_REASON="python3 not found (install Python 3, then re-run)"
else
  SIDECAR_REQUESTED=1
fi

# ---- Phase A: large chat models (background) ----
CHAT_PID=""
if [ "$OLLAMA_OK" = "1" ]; then
  say "Pulling chat models in the background → tail -f $CHAT_LOG"
  (
    set +e
    rc=0
    for m in llama3.2:3b gemma4:e4b; do
      pull_model "$m" || rc=1
    done
    exit $rc
  ) >"$CHAT_LOG" 2>&1 &
  CHAT_PID=$!
else
  warn "Skipping chat-model pulls (Ollama not serving)."
fi

# ---- Phase B: sidecar setup (background) ----
SIDECAR_PID=""
if [ "$SIDECAR_REQUESTED" = "1" ]; then
  say "Setting up the embedding sidecar in the background → tail -f $SIDECAR_SETUP_LOG"
  (
    set +e
    VENV="$SCRIPT_DIR/.venv"

    # If it's already answering, there's nothing to do — fully idempotent.
    if sidecar_up; then
      echo "Sidecar already running on :11435"
      exit 0
    fi

    # Prefer uv + a standalone Python 3.12: that venv is durable against
    # `brew upgrade` (it doesn't depend on Homebrew's interpreter). Fall back to
    # python3 -m venv when uv can't be made available.
    ensure_uv
    if [ -n "$UV" ]; then
      if [ ! -d "$VENV" ]; then
        echo "Creating Python venv with uv (standalone Python 3.12)…"
        "$UV" venv --python 3.12 "$VENV" || { echo "Failed to create venv at $VENV"; exit 1; }
      else
        echo "Reusing existing venv at $VENV"
      fi
      echo "Installing sidecar dependencies (downloads PyTorch — a few minutes the first time)…"
      "$UV" pip install --python "$VENV/bin/python" -r "$SCRIPT_DIR/requirements.txt" || { echo "Failed to install sidecar dependencies"; exit 1; }
      # uv venvs omit pip; setup (and any tooling that shells out to pip) needs it.
      "$UV" pip install --python "$VENV/bin/python" pip || echo "Note: installing pip into the venv failed (continuing)."
      echo "Sidecar dependencies installed"
    else
      if [ ! -d "$VENV" ]; then
        echo "Creating Python venv…"
        python3 -m venv "$VENV" || { echo "Failed to create venv at $VENV"; exit 1; }
      else
        echo "Reusing existing venv at $VENV"
      fi
      warn "Built the venv with python3 -m venv (uv unavailable) — it's interpreter-managed and less durable than a uv/standalone venv (a Python upgrade can break it)."
      echo "Installing sidecar dependencies (downloads PyTorch — a few minutes the first time)…"
      # A failed pip self-upgrade is non-fatal: it must not fail the whole setup
      # when the real dependency install below still succeeds.
      "$VENV/bin/pip" install -q --upgrade pip || echo "Note: pip self-upgrade failed (continuing)."
      "$VENV/bin/pip" install -q -r "$SCRIPT_DIR/requirements.txt" || { echo "Failed to install sidecar dependencies"; exit 1; }
      echo "Sidecar dependencies installed"
    fi

    # Decide how to start the sidecar. With autostart enabled on a supported OS
    # we install a durable service (LaunchAgent / systemd) that ALSO starts it.
    # Otherwise (or on an unsupported OS) we just launch it detached for now.
    AUTOSTART_OK=0
    if [ "$SKIP_AUTOSTART" != "1" ]; then
      if [ "$OS" = "Darwin" ]; then
        AUTOSTART_OK=1
      elif [ "$OS" = "Linux" ] && command -v systemctl >/dev/null 2>&1; then
        AUTOSTART_OK=1
      fi
    fi

    if [ "$AUTOSTART_OK" = "1" ]; then
      echo "Installing the auto-start service (it will also start the sidecar)…"
      bash "$SCRIPT_DIR/install-sidecar-service.sh" --vault-root "$VAULT_ROOT" --scripts-dir "$SCRIPT_DIR" \
        || { echo "Auto-start install failed — falling back to a session-only launch."; AUTOSTART_OK=0; }
    fi

    if [ "$AUTOSTART_OK" != "1" ]; then
      echo "Starting the sidecar for this session…"
      # serve_forever() never returns; launch it detached (its runtime output
      # goes to its OWN log, separate from this setup log) and poll for
      # readiness so this job returns once :11435 answers (or after the
      # timeout) — it does NOT block on the long-lived server.
      nohup "$VENV/bin/python" "$SCRIPT_DIR/embed-sidecar.py" --vault-root "$VAULT_ROOT" >"$SIDECAR_LOG" 2>&1 &
      for _ in $(seq 1 90); do sidecar_up && break; sleep 1; done
    fi

    if sidecar_up; then
      echo "Sidecar is serving on :11435"
      exit 0
    fi
    echo "Sidecar didn't come up within the timeout — check $SIDECAR_LOG"
    exit 1
  ) >"$SIDECAR_SETUP_LOG" 2>&1 &
  SIDECAR_PID=$!
else
  if [ "$SKIP_SIDECAR" = "1" ]; then
    say "Skipping the sidecar ($SIDECAR_SKIP_REASON). Ollama alone covers embeddings + chat."
  else
    warn "Skipping the sidecar — $SIDECAR_SKIP_REASON."
    warn "That's fine — Ollama already provides embeddings; the sidecar is an optional upgrade."
  fi
fi

# ─────────────────── 3. Wait for both, then summarize ───────────────────
# Harvest each job's exit status with `wait <pid>`. Under `set -e` a failing
# background job would normally abort us, so we guard every wait with `|| rc=$?`
# (the `if ! wait …` idiom would WRONGLY read 0, because the negated test resets
# $? before the body runs). bash 3.2 has no `wait -n`; we reap by explicit PID.
CHAT_STATUS=""
if [ -n "$CHAT_PID" ]; then
  say "Waiting for background chat-model pulls to finish…"
  CHAT_RC=0
  wait "$CHAT_PID" || CHAT_RC=$?
  if [ "$CHAT_RC" = "0" ]; then CHAT_STATUS="ok"; else CHAT_STATUS="failed"; fi
fi

SIDECAR_STATUS=""
if [ -n "$SIDECAR_PID" ]; then
  say "Waiting for background sidecar setup to finish…"
  SIDECAR_RC=0
  wait "$SIDECAR_PID" || SIDECAR_RC=$?
  if [ "$SIDECAR_RC" = "0" ]; then SIDECAR_STATUS="ok"; else SIDECAR_STATUS="failed"; fi
fi

# ─────────────────────────── 4. Status summary ───────────────────────────
say "Setup summary"

# Ollama / embeddings
if [ "$OLLAMA_OK" = "1" ]; then
  ok "Ollama serving on :11434"
else
  warn "Ollama not serving (log: $OLLAMA_LOG)"
fi
if [ "$EMBED_OK" = "1" ]; then
  ok "Base embeddings ready: nomic-embed-text"
else
  warn "Base embeddings (nomic-embed-text) not ready"
fi

# Chat models — report each one's true presence regardless of pull race.
if [ "$OLLAMA_OK" = "1" ]; then
  for m in llama3.2:3b gemma4:e4b; do
    if model_present "$m"; then
      ok "chat model present: $m"
    else
      warn "chat model missing: $m (see $CHAT_LOG)"
    fi
  done
elif [ -n "$CHAT_STATUS" ]; then
  warn "chat models: $CHAT_STATUS (see $CHAT_LOG)"
fi

# Sidecar — the authoritative check is whether :11435 actually answers now.
if [ "$SIDECAR_REQUESTED" = "1" ]; then
  if sidecar_up; then
    ok "Sidecar serving on :11435"
  else
    warn "Sidecar not up (status: ${SIDECAR_STATUS:-unknown}, logs: $SIDECAR_SETUP_LOG and $SIDECAR_LOG)"
  fi
else
  warn "Sidecar not set up — $SIDECAR_SKIP_REASON"
fi

say "Done. Reopen Roost's settings — Integrations should show Ollama (and the sidecar) as detected."
echo "  • Logs:  $OLLAMA_LOG   $CHAT_LOG   $SIDECAR_SETUP_LOG   $SIDECAR_LOG"
if [ "$SIDECAR_REQUESTED" = "1" ] && [ "$SKIP_AUTOSTART" != "1" ]; then
  echo "  • The sidecar auto-starts at login (LaunchAgent/systemd). Remove it with scripts/uninstall-sidecar-service.sh, or re-run with --skip-autostart to set it up session-only."
else
  echo "  • Auto-start NOT installed. Run scripts/install-sidecar-service.sh --vault-root <path> to keep the sidecar running after a reboot (uninstall with scripts/uninstall-sidecar-service.sh)."
fi
