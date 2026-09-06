#!/usr/bin/env bash
# install.sh — put the native capture helper in place without needing a Swift toolchain.
#
# Order matters: an already-built binary wins, then the published release, and only then a
# local build. Downloading is the common path for someone installing the plugin; building is
# the fallback for a fork, an unreleased commit, or an architecture we do not ship.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$DIR/.build/release/iai-capture"
REPO="${IAI_REPO:-sasanchezcorrea/interview-ai}"
TAG="${IAI_HELPER_TAG:-v0.2.0}"
ARCH="$(uname -m)"
SHA_arm64="5bcd9ef80b2218bed9ab8ac167bcbab06bff157f064cccea80c97db29e88f364"

[ "$(uname -s)" = "Darwin" ] || { echo "ERROR: the native helper is macOS-only (ScreenCaptureKit)"; exit 1; }
if [ -x "$BIN" ]; then echo "OK  helper already present: $BIN"; exit 0; fi

build_from_source() {
  command -v swift >/dev/null || { echo "ERROR: no prebuilt binary for $ARCH and no swift toolchain to build one"; exit 1; }
  echo "building from source…"; (cd "$DIR" && swift build -c release)
  [ -x "$BIN" ] || { echo "ERROR: build finished but $BIN is missing"; exit 1; }
  echo "OK  built: $BIN"; exit 0
}

# We only publish arm64 today. Rosetta would let an x86_64 host run it, but a capture process
# that must hold Screen Recording permission has no business running translated: build instead.
[ "$ARCH" = "arm64" ] || build_from_source

URL="https://github.com/$REPO/releases/download/$TAG/iai-capture-macos-arm64.tar.gz"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "downloading $TAG…"
curl -fsSL --retry 2 -o "$TMP/h.tar.gz" "$URL" || { echo "download failed ($URL)"; build_from_source; }

GOT="$(shasum -a 256 "$TMP/h.tar.gz" | cut -d' ' -f1)"
if [ "$GOT" != "$SHA_arm64" ]; then
  # A mismatch means the asset is not the one this script was written against. Never install it:
  # this binary gets Screen Recording permission.
  echo "ERROR: checksum mismatch for $URL"; echo "  expected $SHA_arm64"; echo "  got      $GOT"; exit 1
fi

mkdir -p "$DIR/.build/release"
tar -xzf "$TMP/h.tar.gz" -C "$DIR/.build/release" iai-capture
chmod +x "$BIN"
xattr -d com.apple.quarantine "$BIN" 2>/dev/null || true
"$BIN" --list >/dev/null 2>&1 || echo "NOTE: the helper is installed but could not list sources yet — macOS will ask for Screen Recording on first capture"
echo "OK  helper installed: $BIN"
