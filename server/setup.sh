#!/usr/bin/env bash
# setup.sh — one-shot dependencies for Interview AI: whisper.cpp server + model, ffmpeg, dirs.
# Usage: server/setup.sh            (model small, multilingual, ~470 MB)
#        IAI_WHISPER_SIZE=medium server/setup.sh   (better accuracy, slower)
set -euo pipefail
SIZE="${IAI_WHISPER_SIZE:-small}"
DEST="$HOME/.cache/whisper/ggml-$SIZE.bin"
command -v brew >/dev/null || { echo "ERROR: Homebrew is required (https://brew.sh)"; exit 1; }
command -v whisper-server >/dev/null || brew install whisper-cpp
command -v ffmpeg >/dev/null || brew install ffmpeg
mkdir -p "$HOME/.cache/whisper" /tmp/interview-ai "${IAI_USER_DIR:-$HOME/.interview-ai}"
if [ ! -s "$DEST" ]; then
  echo "downloading ggml-$SIZE.bin…"
  curl -L --fail --progress-bar -o "$DEST.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$SIZE.bin"
  mv "$DEST.part" "$DEST"
fi
# The native helper is what makes capture work with no picker and no share-audio checkbox.
# install.sh downloads the published binary and verifies its checksum, falling back to a build.
bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/../helper" && pwd)/install.sh" || echo "WARN: native helper unavailable — the browser capture path still works"
command -v claude >/dev/null || echo "WARN: claude CLI not found on PATH (the brain needs it)"
command -v bun >/dev/null || echo "WARN: bun not found on PATH (the server needs it)"
echo "OK  whisper-server: $(command -v whisper-server)"
echo "OK  model:          $DEST ($(du -h "$DEST" | cut -f1))"
echo "OK  ffmpeg:         $(command -v ffmpeg)"
echo "OK  Chrome:         $([ -d '/Applications/Google Chrome.app' ] && echo present || echo 'not found (needed for tab capture)')"
[ "$SIZE" != "small" ] && echo "NOTE: run the server with IAI_WHISPER_MODEL=$DEST"
exit 0
