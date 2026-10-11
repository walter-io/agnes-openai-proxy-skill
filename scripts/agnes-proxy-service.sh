#!/usr/bin/env bash
# Agnes OpenAI proxy - service manager for macOS / Linux
# Usage: ./agnes-proxy-service.sh {start|stop|status|restart|install-autostart|uninstall-autostart}
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
PROXY="$DIR/agnes-openai-proxy.mjs"
LOG="$DIR/agnes-proxy.log"
PORT="${PORT:-18787}"
PLIST=~/Library/LaunchAgents/cn.agnes.proxy.plist
UNIT=~/.config/systemd/user/agnes-proxy.service

node_bin() { command -v node || echo /usr/local/bin/node; }

do_start() {
  if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo "already running on :$PORT"; return 0
  fi
  nohup "$(node_bin)" "$PROXY" >>"$LOG" 2>&1 &
  echo "started (pid $!) -> log: $LOG"
}

do_stop() { pkill -f "agnes-openai-proxy.mjs" && echo "stopped" || echo "not running"; }

do_status() {
  if curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo "RUNNING  http://127.0.0.1:$PORT/v1"
  else
    echo "NOT RUNNING (check $LOG)"
  fi
}

install_autostart() {
  mkdir -p "$(dirname "$PLIST")" "$(dirname "$UNIT")"
  if [[ "$(uname)" == "Darwin" ]]; then
    cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>cn.agnes.proxy</string>
  <key>ProgramArguments</key><array>
    <string>$(node_bin)</string><string>$PROXY</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
EOF
    launchctl unload "$PLIST" 2>/dev/null; launchctl load "$PLIST"
    echo "installed: $PLIST (auto-start on login, keep-alive)"
  elif command -v systemctl >/dev/null 2>&1; then
    cat >"$UNIT" <<EOF
[Unit]
Description=Agnes OpenAI Proxy
[Service]
ExecStart=$(node_bin) $PROXY
Restart=always
RestartSec=5
[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now agnes-proxy.service
    echo "installed: $UNIT (systemd user service)"
  else
    echo "Add to crontab -e:  @reboot $(node_bin) $PROXY >> $LOG 2>&1"
  fi
}

uninstall_autostart() {
  if [[ "$(uname)" == "Darwin" && -f "$PLIST" ]]; then
    launchctl unload "$PLIST"; rm -f "$PLIST"; echo "removed $PLIST"
  elif [[ -f "$UNIT" ]]; then
    systemctl --user disable --now agnes-proxy.service 2>/dev/null; rm -f "$UNIT"; echo "removed $UNIT"
  else
    echo "no autostart entry found"
  fi
}

case "${1:-}" in
  start) do_start ;;
  stop) do_stop ;;
  restart) do_stop; sleep 1; do_start ;;
  status) do_status ;;
  install-autostart) install_autostart ;;
  uninstall-autostart) uninstall_autostart ;;
  *) echo "Usage: $0 {start|stop|status|restart|install-autostart|uninstall-autostart}"; exit 1 ;;
esac
