#!/usr/bin/env bash
#
# Roost — remove the auto-start service installed by install-sidecar-service.sh.
#
#   ./scripts/uninstall-sidecar-service.sh
#
# Stops + unloads the service and deletes the files it created. Never errors if
# something is already absent. Does NOT touch the .venv or embed-sidecar.py.
#
set -euo pipefail

LABEL="com.roost.embed-sidecar"
OS="$(uname -s)"

say()  { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
ok()   { printf "  \033[1;32m✓ %s\033[0m\n" "$*"; }

case "$OS" in
  Darwin)
    say "Removing the macOS LaunchAgent"
    DOM="gui/$(id -u)"
    launchctl bootout "$DOM/$LABEL" 2>/dev/null || true
    i=0
    while launchctl print "$DOM/$LABEL" >/dev/null 2>&1; do
      i=$((i + 1)); [ "$i" -ge 40 ] && break; sleep 0.25
    done
    rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
    ok "Removed $HOME/Library/LaunchAgents/$LABEL.plist"
    rm -rf "$HOME/Library/Application Support/Roost"
    ok "Removed $HOME/Library/Application Support/Roost"
    ;;
  Linux)
    say "Removing the systemd user service"
    systemctl --user disable --now roost-sidecar.service 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/roost-sidecar.service"
    ok "Removed $HOME/.config/systemd/user/roost-sidecar.service"
    systemctl --user daemon-reload 2>/dev/null || true
    ;;
  *)
    say "Nothing to remove on $OS (no auto-start service was installed)."
    ;;
esac

say "Done. The sidecar auto-start has been removed."
echo "  (The .venv and embed-sidecar.py are left untouched.)"
