#!/usr/bin/env bash
# release.sh — build, sign and package the capture helper for a GitHub release.
#
# Signing matters more here than for a normal CLI: macOS keys Screen Recording permission to the
# binary's identity. Ad-hoc signing gives a fresh identity on every rebuild, so each release makes
# the user grant permission again. A Developer ID certificate gives one stable identity across
# releases, and notarization stops Gatekeeper warning about it.
#
# Usage:  helper/release.sh v0.3.0
#   Signs with Developer ID + notarizes when a certificate is present; ad-hoc otherwise.
#   Set IAI_NOTARY_PROFILE to a `xcrun notarytool store-credentials` profile to notarize.
set -euo pipefail
TAG="${1:?usage: release.sh <tag>, e.g. v0.3.0}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$DIR/.release"; BIN="$DIR/.build/release/iai-capture"
ARCH="$(uname -m)"; ASSET="iai-capture-macos-$ARCH.tar.gz"

(cd "$DIR" && swift build -c release)
# `|| true`: grep exits 1 when there is no certificate, which under `set -e` aborts the whole
# script at the exact moment the ad-hoc fallback is supposed to take over.
IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | grep -o '"Developer ID Application: [^"]*"' | head -1 | tr -d '"' || true)"
if [ -n "$IDENTITY" ]; then
  echo "signing as: $IDENTITY"
  # --options runtime is required for notarization; without it the submission is rejected.
  codesign --force --timestamp --options runtime --sign "$IDENTITY" "$BIN"
else
  echo "WARN: no Developer ID certificate found — signing ad-hoc."
  echo "      Every release will then re-prompt for Screen Recording permission."
  codesign --force --sign - "$BIN"
fi
codesign --verify --strict --verbose=1 "$BIN"

mkdir -p "$OUT" && cp "$BIN" "$OUT/" && (cd "$OUT" && tar -czf "$ASSET" iai-capture)

if [ -n "$IDENTITY" ] && [ -n "${IAI_NOTARY_PROFILE:-}" ]; then
  echo "notarizing…"
  xcrun notarytool submit "$OUT/$ASSET" --keychain-profile "$IAI_NOTARY_PROFILE" --wait
  # A .tar.gz cannot carry a stapled ticket; Gatekeeper checks online instead. Notarizing the
  # archive is still what clears the download, so this is the last step, not a missing one.
fi

SHA="$(shasum -a 256 "$OUT/$ASSET" | cut -d' ' -f1)"
echo
echo "asset:  $OUT/$ASSET"
echo "sha256: $SHA"
echo
echo "Next: put that SHA in helper/install.sh (SHA_$ARCH), commit, tag $TAG, and upload the asset."
