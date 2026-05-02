#!/usr/bin/env bash
#
# scripts/cleanup-test-fixtures.sh
#
# One-shot cleanup of accumulated Rust test-fixture debris under the
# canvas-terminal managed worktrees root.
#
# Background: before PR-A's TempDir test-root override (commit landing
# this script), every `cargo test` run under src-tauri/ created managed
# worktree paths under the production root `~/.cache/canvas-terminal/
# worktrees/`. On a developer machine that ran tests for months, this
# accumulated thousands of empty `test-{ok,force,unmerged,...}-*` dirs.
# At the time PR-A landed, this machine had ~1903 such entries.
#
# This script deletes ONLY directories matching the documented test
# fixture pattern under EXACTLY the production worktrees root. Anything
# else is skipped — including:
#   - real session-* dirs from collaborator-mode runs
#   - non-fixture test-* dirs that don't match the fence
#   - any path not directly under the production root
#
# After running, `cargo test` should never recreate fixture entries here
# because git.rs's worktrees_root() now redirects under #[cfg(test)] to a
# process-wide TempDir.
#
# Usage:
#   ./scripts/cleanup-test-fixtures.sh           # dry-run (lists what would be deleted)
#   ./scripts/cleanup-test-fixtures.sh --apply   # actually delete

set -euo pipefail

ROOT="$HOME/.cache/canvas-terminal/worktrees"

# Safety fence: must match exactly one of these labels followed by a dash.
# These are every label passed to `make_managed_worktree_path()` in
# `git.rs` test fixtures as of PR-A — derived by:
#   grep -oE 'make_managed_worktree_path\("[^"]+"\)' src-tauri/src/commands/git.rs | sort -u
# If a future PR adds a new fixture label, this regex must be updated AND
# tests must keep using the TempDir override (so the production root stays
# clean and this regex never has to grow).
FENCE_REGEX='^test-(approval|conflict|diff|dirty-parent|e2e-conflict|empty|fail|force|list|merge|ns|ok|remove|restore|status|unmerged|upstream)-'

if [[ ! -d "$ROOT" ]]; then
    echo "Production worktrees root does not exist: $ROOT"
    echo "Nothing to clean up. Exiting."
    exit 0
fi

APPLY=false
if [[ "${1:-}" == "--apply" ]]; then
    APPLY=true
fi

echo "Production root: $ROOT"
if $APPLY; then
    echo "Mode: APPLY (will delete matching entries)"
else
    echo "Mode: DRY-RUN (use --apply to actually delete)"
fi
echo

# Iterate the immediate children of $ROOT only (-mindepth 1 -maxdepth 1).
# We never recurse — fixtures are top-level entries by construction.
COUNT=0
SKIPPED=0
while IFS= read -r -d '' entry; do
    base="$(basename "$entry")"
    parent_dir="$(dirname "$entry")"

    # Belt-and-braces: confirm parent is exactly $ROOT, not some unexpected
    # nested path. find with -maxdepth 1 already guarantees this, but
    # asserting again keeps the safety contract obvious if someone edits
    # the find invocation later.
    if [[ "$parent_dir" != "$ROOT" ]]; then
        echo "  [SKIP-NOT-ROOT] $entry (parent=$parent_dir)" >&2
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    if [[ ! "$base" =~ $FENCE_REGEX ]]; then
        # Not a recognized fixture pattern — skip silently in dry-run,
        # log in apply mode for visibility.
        if $APPLY; then
            echo "  [SKIP-NOT-FIXTURE] $base"
        fi
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    if $APPLY; then
        rm -rf -- "$entry"
        echo "  [DELETED] $base"
    else
        echo "  [WOULD-DELETE] $base"
    fi
    COUNT=$((COUNT + 1))
done < <(find "$ROOT" -mindepth 1 -maxdepth 1 -type d -print0)

echo
if $APPLY; then
    echo "Deleted $COUNT test-fixture entries."
else
    echo "Would delete $COUNT test-fixture entries (re-run with --apply to delete)."
fi
echo "Skipped $SKIPPED non-matching entries."
