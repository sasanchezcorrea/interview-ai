#!/usr/bin/env bash
# stop.sh — stop the sidecar and the whisper-server it started, scoped to their ports.
#
# It used to be `pkill -f "bun server.ts"`, which matches EVERY bun process running a file called
# server.ts on the machine — a second Interview AI instance, or somebody else's unrelated project.
# Killing by listening port hits exactly the instance this script is configured for.
PORT="${IAI_PORT:-31338}"
WPORT="${IAI_WHISPER_PORT:-8178}"

stop_port() {
  local port="$1" what="$2"
  local pids; pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then echo "$what not running (port $port)"; return; fi
  # TERM first so the sidecar can tear the capture down; a killed capture leaves macOS believing
  # the screen is still being recorded.
  kill $pids 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 0.3
    lsof -ti "tcp:$port" -sTCP:LISTEN >/dev/null 2>&1 || { echo "$what stopped (port $port)"; return; }
  done
  kill -9 $pids 2>/dev/null || true
  echo "$what force-killed (port $port)"
}

stop_port "$PORT" "sidecar"
stop_port "$WPORT" "whisper-server"
exit 0
