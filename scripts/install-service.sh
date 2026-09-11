#!/usr/bin/env bash
# Keep the hub running: install it as a launchd agent (macOS) or a systemd user
# service (Linux), so it survives a crash, a logout and a reboot.
#
#   scripts/install-service.sh           install and start
#   scripts/install-service.sh --uninstall
#
# A mailbox that is only up while a terminal window is open is not a mailbox —
# the whole promise is that a message sent at 3am is there in the morning.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
LABEL="agent-mailbox"
NODE="$(command -v node)"

if [ ! -f "$ROOT/dist/cli.js" ]; then
  echo "no build at $ROOT/dist/cli.js — run: npm install" >&2
  exit 1
fi
if [ ! -f "$ROOT/mailbox.config.json" ]; then
  echo "no mailbox.config.json — run: node dist/cli.js init <agent-id>..." >&2
  exit 1
fi

case "$(uname -s)" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/com.$LABEL.plist"
    if [ "${1:-}" = "--uninstall" ]; then
      launchctl unload "$PLIST" 2>/dev/null || true
      rm -f "$PLIST"
      echo "uninstalled $PLIST"
      exit 0
    fi
    mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string>
    <string>$ROOT/dist/cli.js</string>
    <string>serve</string>
    <string>--config</string>
    <string>$ROOT/mailbox.config.json</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$ROOT/hub.log</string>
  <key>StandardErrorPath</key><string>$ROOT/hub.err</string>
</dict></plist>
PLISTEOF
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "installed $PLIST"
    echo "  restart: launchctl kickstart -k gui/\$(id -u)/com.$LABEL"
    echo "  logs:    tail -f $ROOT/hub.log"
    ;;

  Linux)
    UNIT="$HOME/.config/systemd/user/$LABEL.service"
    if [ "${1:-}" = "--uninstall" ]; then
      systemctl --user disable --now "$LABEL" 2>/dev/null || true
      rm -f "$UNIT"
      systemctl --user daemon-reload
      echo "uninstalled $UNIT"
      exit 0
    fi
    mkdir -p "$(dirname "$UNIT")"
    cat > "$UNIT" <<UNITEOF
[Unit]
Description=agent-mailbox
After=network.target

[Service]
ExecStart=$NODE $ROOT/dist/cli.js serve --config $ROOT/mailbox.config.json
WorkingDirectory=$ROOT
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
UNITEOF
    systemctl --user daemon-reload
    systemctl --user enable --now "$LABEL"
    echo "installed $UNIT"
    echo "  restart: systemctl --user restart $LABEL"
    echo "  logs:    journalctl --user -u $LABEL -f"
    ;;

  *)
    echo "unsupported platform $(uname -s); run \`npm start\` under your own supervisor" >&2
    exit 1
    ;;
esac
