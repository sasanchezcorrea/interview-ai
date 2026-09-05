#!/usr/bin/env bash
# stop.sh — stop the sidecar and the whisper-server it started.
pkill -f "bun server.ts" 2>/dev/null && echo "sidecar stopped" || echo "sidecar not running"
pkill -f "whisper-server" 2>/dev/null && echo "whisper-server stopped" || echo "whisper-server not running"
exit 0
