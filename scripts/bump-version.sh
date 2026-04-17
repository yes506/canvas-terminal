#!/usr/bin/env bash
set -euo pipefail

# Version bump script for Canvas Terminal
# Keeps package.json, Cargo.toml, and tauri.conf.json in sync.
#
# Usage:
#   ./scripts/bump-version.sh patch   # 0.1.0 → 0.1.1
#   ./scripts/bump-version.sh minor   # 0.1.0 → 0.2.0
#   ./scripts/bump-version.sh major   # 0.1.0 → 1.0.0
#   ./scripts/bump-version.sh 1.2.3   # set exact version

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/package.json"
CARGO="$ROOT/src-tauri/Cargo.toml"
TAURI="$ROOT/src-tauri/tauri.conf.json"

# Read current version from package.json
CURRENT=$(jq -r '.version' "$PKG")

if [[ -z "${1:-}" ]]; then
  echo "Current version: $CURRENT"
  echo ""
  echo "Usage: $0 <patch|minor|major|X.Y.Z>"
  exit 0
fi

BUMP="$1"

# Parse current version
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$BUMP" in
  patch) NEW="$MAJOR.$MINOR.$((PATCH + 1))" ;;
  minor) NEW="$MAJOR.$((MINOR + 1)).0" ;;
  major) NEW="$((MAJOR + 1)).0.0" ;;
  *)
    if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      NEW="$BUMP"
    else
      echo "Error: Invalid version '$BUMP'. Use patch, minor, major, or X.Y.Z"
      exit 1
    fi
    ;;
esac

echo "Bumping version: $CURRENT → $NEW"

# Update package.json
jq --arg v "$NEW" '.version = $v' "$PKG" > "$PKG.tmp" && mv "$PKG.tmp" "$PKG"

# Update Cargo.toml (only the [package] version line, not dependency versions)
# Use awk to replace only the first occurrence of version = "..."
awk -v old="$CURRENT" -v new="$NEW" '
  !done && /^version = "/ { sub("\"" old "\"", "\"" new "\""); done=1 }
  { print }
' "$CARGO" > "$CARGO.tmp" && mv "$CARGO.tmp" "$CARGO"

# Update tauri.conf.json
jq --arg v "$NEW" '.version = $v' "$TAURI" > "$TAURI.tmp" && mv "$TAURI.tmp" "$TAURI"

echo "Updated:"
echo "  package.json:     $NEW"
echo "  Cargo.toml:       $NEW"
echo "  tauri.conf.json:  $NEW"

# Create git tag
if [[ "${2:-}" == "--tag" ]]; then
  git -C "$ROOT" add "$PKG" "$CARGO" "$TAURI"
  git -C "$ROOT" commit -m "chore: bump version to v$NEW"
  git -C "$ROOT" tag -a "v$NEW" -m "Release v$NEW"
  echo ""
  echo "Created commit and tag: v$NEW"
  echo "Push with: git push && git push --tags"
fi
