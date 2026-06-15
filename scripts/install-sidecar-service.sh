#!/usr/bin/env bash
#
# Roost — install the local sidecar (embeddings + speech-to-text) as a durable
# auto-start service, then start it.
#
#   ./scripts/install-sidecar-service.sh --vault-root /path/to/vault
#
# On macOS this builds an ad-hoc-signed RoostSidecar.app bundle on a local,
# non-protected path under ~/Library/Application Support/Roost (so the Login
# Items / "Allow in the Background" item reads "RoostSidecar" instead of "sh")
# and installs a LaunchAgent that runs the bundle executable. On Linux it
# installs a systemd --user unit. Other OSes print manual guidance.
#
#   --vault-root <path>    Vault root (or set ROOST_VAULT). Required.
#   --scripts-dir <path>   Where .venv + embed-sidecar.py live.
#                          Defaults to the dir containing this script.
#   -h, --help             Show this help.
#
# Idempotent + safe to re-run. Reverse it with uninstall-sidecar-service.sh.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPTS_DIR=""
VAULT_ROOT="${ROOST_VAULT:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --vault-root)
      if [ $# -lt 2 ]; then echo "Error: --vault-root needs a path (try --help)"; exit 1; fi
      VAULT_ROOT="$2"; shift 2 ;;
    --scripts-dir)
      if [ $# -lt 2 ]; then echo "Error: --scripts-dir needs a path (try --help)"; exit 1; fi
      SCRIPTS_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1 (try --help)"; exit 1 ;;
  esac
done

[ -n "$SCRIPTS_DIR" ] || SCRIPTS_DIR="$SCRIPT_DIR"
if [ -z "$VAULT_ROOT" ]; then
  echo "Error: no vault path. Pass --vault-root /path/to/vault or set ROOST_VAULT." >&2
  exit 1
fi

LABEL="com.roost.embed-sidecar"
LAUNCHER="$SCRIPTS_DIR/sidecar-launcher.sh"
INFO_PLIST="$SCRIPTS_DIR/RoostSidecar.Info.plist"
LOG="$SCRIPTS_DIR/sidecar.log"
OS="$(uname -s)"

say()  { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
ok()   { printf "  \033[1;32m✓ %s\033[0m\n" "$*"; }
warn() { printf "  \033[1;33m! %s\033[0m\n" "$*"; }

sidecar_up() { curl -fsS --max-time 3 http://localhost:11435/health >/dev/null 2>&1; }

# Poll :11435/health for up to ~120s (60 × 2s); report success/failure.
poll_sidecar() {
  say "Waiting for the sidecar to come up on :11435…"
  for _ in $(seq 1 60); do
    if sidecar_up; then ok "Sidecar is serving on :11435"; return 0; fi
    sleep 2
  done
  warn "Sidecar didn't answer on :11435 within the timeout — check $LOG"
  return 1
}

# ─────────────────────────────── macOS ───────────────────────────────
install_macos() {
  local DOM="gui/$(id -u)"
  local PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  local APP="$HOME/Library/Application Support/Roost/RoostSidecar.app"
  local EXE="$APP/Contents/MacOS/RoostSidecar"

  [ -f "$LAUNCHER" ]    || { echo "Error: launcher not found at $LAUNCHER" >&2; exit 1; }
  [ -f "$INFO_PLIST" ]  || { echo "Error: Info.plist not found at $INFO_PLIST" >&2; exit 1; }

  # Build the app bundle on LOCAL disk (NOT the synced vault, NOT
  # Desktop/Documents/Downloads — both are EIO causes for launchd). The bundle is
  # what makes the Login Items / "Allow in the Background" entry read "RoostSidecar"
  # instead of "sh". (A real developer NAME would need a paid Apple Developer ID;
  # the item name comes from the bundle and works with ad-hoc signing.) The
  # launcher finds the venv on the vault via ROOST_SCRIPTS_DIR.
  say "Building $APP"
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS"
  cp "$LAUNCHER" "$EXE"
  chmod +x "$EXE"
  cp "$INFO_PLIST" "$APP/Contents/Info.plist"

  say "Code-signing the bundle (ad-hoc)"
  codesign --force --deep -s - "$APP"
  ok "Signed $APP"

  say "Writing LaunchAgent $PLIST"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$EXE</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ROOST_VAULT</key>
    <string>$VAULT_ROOT</string>
    <key>ROOST_SCRIPTS_DIR</key>
    <string>$SCRIPTS_DIR</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
PLIST_EOF
  chmod 0644 "$PLIST"
  if ! plutil -lint "$PLIST" >/dev/null; then
    echo "Error: generated LaunchAgent plist is invalid ($PLIST)" >&2
    exit 1
  fi
  ok "LaunchAgent written and validated"

  # Race-safe (re)load: bootout is ASYNC, so poll until the label is actually gone
  # before re-bootstrapping (back-to-back bootout+bootstrap causes
  # "Bootstrap failed: 5: Input/output error"). enable first (a persistently
  # disabled label can't bootstrap); retry bootstrap a few times on transient EIO.
  say "Loading the LaunchAgent"
  launchctl bootout "$DOM/$LABEL" 2>/dev/null || true
  local i=0
  while launchctl print "$DOM/$LABEL" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -ge 40 ] && break; sleep 0.25
  done
  launchctl enable "$DOM/$LABEL" 2>/dev/null || true
  local loaded=0 attempt=0
  while [ "$attempt" -lt 5 ]; do
    attempt=$((attempt + 1))
    if launchctl bootstrap "$DOM" "$PLIST" 2>/dev/null; then loaded=1; break; fi
    sleep 2
  done
  if [ "$loaded" != 1 ]; then
    warn "launchctl bootstrap failed for $DOM/$LABEL after retries."
    warn "Check: launchctl print $DOM/$LABEL   (and Console.app for launchd errors)"
    exit 1
  fi
  ok "LaunchAgent loaded ($LABEL)"

  # Force the CURRENT code to be the running instance (picks up an updated
  # launcher on a re-install). -k kills any running instance; the launcher then
  # restarts the sidecar. Harmless on a fresh install.
  launchctl kickstart -k "$DOM/$LABEL" 2>/dev/null || true
  poll_sidecar || true
}

# ─────────────────────────────── Linux ───────────────────────────────
install_linux() {
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl not found — can't install a systemd service automatically."
    echo "  To run the sidecar manually:"
    echo "    ROOST_VAULT='$VAULT_ROOT' ROOST_SCRIPTS_DIR='$SCRIPTS_DIR' sh '$LAUNCHER'"
    exit 0
  fi

  local UNIT_DIR="$HOME/.config/systemd/user"
  local UNIT="$UNIT_DIR/roost-sidecar.service"

  say "Writing systemd user unit $UNIT"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=Roost embedding/ASR sidecar

[Service]
Environment=ROOST_VAULT=$VAULT_ROOT
Environment=ROOST_SCRIPTS_DIR=$SCRIPTS_DIR
ExecStart=/bin/sh $LAUNCHER
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
UNIT_EOF
  ok "Unit written"

  say "Enabling + starting the service"
  systemctl --user daemon-reload
  systemctl --user enable --now roost-sidecar.service
  ok "roost-sidecar.service enabled and started"

  poll_sidecar || true
}

# ─────────────────────────────── dispatch ───────────────────────────────
case "$OS" in
  Darwin) install_macos ;;
  Linux)  install_linux ;;
  *)
    warn "auto-start not supported on $OS; the sidecar will run only while started manually."
    echo "  To run it by hand:"
    echo "    ROOST_VAULT='$VAULT_ROOT' ROOST_SCRIPTS_DIR='$SCRIPTS_DIR' sh '$LAUNCHER'"
    exit 0
    ;;
esac

say "Done. The sidecar will now auto-start at login."
echo "  • Service log: $LOG"
echo "  • Remove it with: $SCRIPTS_DIR/uninstall-sidecar-service.sh"
