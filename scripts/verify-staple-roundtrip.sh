#!/usr/bin/env bash
# Verify that gzipping + extracting a stapled .app preserves the staple ticket
# AND its xattrs. Without this check, `gtar -czf` could ship bytes that pass
# `xcrun stapler validate` (which reads the ticket file) while failing
# Gatekeeper's offline launch (which also consults xattrs).
#
# This project relies on xattr preservation — see release.yml's DMG re-bundle
# step which explicitly chose `ditto` over `cp -R` because "the staple ticket
# is stored as both a ticket file and xattrs."
#
# Usage: verify-staple-roundtrip.sh <path-to-stapled-app> <path-to-tarball>
#
# Exits non-zero on any mismatch. Do NOT bypass this check (e.g., with `|| true`)
# — the failure mode it prevents (broken offline launch on user machines) is
# invisible until users report it, by which point the bad release has shipped.

set -euo pipefail

APP="${1:?usage: $0 <stapled-app> <tarball>}"
TARBALL="${2:?usage: $0 <stapled-app> <tarball>}"

if [ ! -d "$APP" ]; then
  echo "ERROR: stapled .app not found at $APP" >&2
  exit 1
fi
if [ ! -f "$TARBALL" ]; then
  echo "ERROR: tarball not found at $TARBALL" >&2
  exit 1
fi

# 1) Pre-tar staple validate — must pass before we package the bytes.
xcrun stapler validate "$APP"

# 2) Extract to a scratch directory and re-validate the staple.
SCRATCH="$(mktemp -d)"
ORIG_TXT="$(mktemp)"
EXTRACTED_TXT="$(mktemp)"
trap 'rm -rf "$SCRATCH" "$ORIG_TXT" "$EXTRACTED_TXT"' EXIT

gtar -C "$SCRATCH" --xattrs --xattrs-include='*' -xzf "$TARBALL"

APP_BASE="$(basename "$APP")"
EXTRACTED="$SCRATCH/$APP_BASE"
xcrun stapler validate "$EXTRACTED"

# 3) xattr-diff round-trip check.
# `xattr -lr <path>` prefixes every output line with the input path, so we must
# run both sides from the bundle's parent dir using the basename — that way the
# path prefixes match and only real xattr differences surface. Without this,
# the diff would always report drift (different absolute parent paths) even
# when xattrs are identical.
ORIG_PARENT="$(dirname "$APP")"
( cd "$ORIG_PARENT" && xattr -lr "$APP_BASE" ) | LC_ALL=C sort > "$ORIG_TXT"
( cd "$SCRATCH"     && xattr -lr "$APP_BASE" ) | LC_ALL=C sort > "$EXTRACTED_TXT"

if ! diff -u "$ORIG_TXT" "$EXTRACTED_TXT"; then
  echo "ERROR: xattr drift across tar round-trip — staple may be silently broken" >&2
  echo "       (see scripts/verify-staple-roundtrip.sh for why this matters)" >&2
  exit 1
fi

echo "OK: staple round-trip preserved (ticket + xattrs)"
