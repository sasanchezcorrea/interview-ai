#!/usr/bin/env bash
# start.sh — launch the sidecar fully detached (own session), so it survives the shell,
# terminal or agent tool-call that started it. `nohup … &` alone does NOT survive a
# process-group kill; start_new_session=True (setsid) does. macOS has no setsid(1).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="${IAI_LOG:-/tmp/interview-ai/server.log}"
PORT="${IAI_PORT:-31338}"
mkdir -p "$(dirname "$LOG")"

if curl -s -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "already running → http://127.0.0.1:$PORT"; exit 0
fi

BUN="$(command -v bun)" || { echo "ERROR: bun not on PATH"; exit 1; }
python3 - "$BUN" "$DIR" "$LOG" <<'PY'
import os, subprocess, sys
bun, d, log = sys.argv[1:4]
f = open(log, "ab", buffering=0)
p = subprocess.Popen([bun, "server.ts"], cwd=d, stdout=f, stderr=f, stdin=subprocess.DEVNULL, start_new_session=True)
print(p.pid)
PY

for i in $(seq 1 90); do
  sleep 1
  if curl -s -m 1 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"whisper":true'; then
    echo "ready after ${i}s → http://127.0.0.1:$PORT"; exit 0
  fi
done
echo "WARN: server up but whisper not ready after 90s — check $LOG"; exit 1
