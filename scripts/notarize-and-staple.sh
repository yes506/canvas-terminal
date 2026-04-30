#!/usr/bin/env bash
# Submit an artifact to Apple's notary service, poll for the verdict, then staple
# the ticket on success. Retries the *poll* on transient network errors instead
# of resubmitting — Tauri's bundler retries the entire build on a dropped
# long-poll, which spawns duplicate Apple submissions and amplifies the hang.
#
# Required env: APPLE_API_KEY_PATH, APPLE_API_KEY_ID, APPLE_API_ISSUER
#
# Usage: notarize-and-staple.sh <submit_artifact> [<staple_target>]
#   submit_artifact:  file submitted to notarytool (.dmg / .zip / .pkg)
#   staple_target:    file/bundle to staple after acceptance (default: submit_artifact)
#
# When notarizing a .app, submit a zip of it but staple the unzipped .app:
#   ditto -c -k --keepParent "Foo.app" /tmp/foo.zip
#   notarize-and-staple.sh /tmp/foo.zip "Foo.app"

set -euo pipefail

ARTIFACT="${1:-}"
STAPLE_TARGET="${2:-${1:-}}"

if [ -z "$ARTIFACT" ]; then
  echo "Usage: $0 <submit_artifact> [staple_target]" >&2
  exit 2
fi

if [ ! -e "$ARTIFACT" ]; then
  echo "ERROR: artifact not found: $ARTIFACT" >&2
  exit 2
fi

: "${APPLE_API_KEY_PATH:?APPLE_API_KEY_PATH must be set}"
: "${APPLE_API_KEY_ID:?APPLE_API_KEY_ID must be set}"
: "${APPLE_API_ISSUER:?APPLE_API_ISSUER must be set}"

NOTARY_ARGS=(
  --key "$APPLE_API_KEY_PATH"
  --key-id "$APPLE_API_KEY_ID"
  --issuer "$APPLE_API_ISSUER"
  --output-format json
)

# Fail fast on bad credentials. A two-line ping costs nothing and saves a
# 30-minute false drag if the .p8 / key id / issuer trio is wrong.
echo "Validating notary credentials..."
if ! xcrun notarytool history "${NOTARY_ARGS[@]}" >/dev/null 2>"${TMPDIR:-/tmp}/notary-creds-err.$$"; then
  echo "ERROR: notarytool credentials check failed" >&2
  cat "${TMPDIR:-/tmp}/notary-creds-err.$$" >&2 || true
  rm -f "${TMPDIR:-/tmp}/notary-creds-err.$$"
  exit 2
fi
rm -f "${TMPDIR:-/tmp}/notary-creds-err.$$"

echo "Submitting $ARTIFACT for notarization (no-wait)..."
SUB_JSON=$(xcrun notarytool submit "$ARTIFACT" "${NOTARY_ARGS[@]}" --no-wait)
SUB_ID=$(printf '%s' "$SUB_JSON" | jq -r .id)
if [ -z "$SUB_ID" ] || [ "$SUB_ID" = "null" ]; then
  echo "ERROR: submission did not return an id" >&2
  printf '%s\n' "$SUB_JSON" >&2
  exit 1
fi
echo "Submission id: $SUB_ID"

# Poll for the verdict. Retry the poll itself on transient network errors;
# the submission is already in flight at Apple, so we never re-submit.
DEADLINE=$(( $(date +%s) + 1800 ))   # 30 minutes hard cap
STATUS="In Progress"
CONSEC_FAILS=0
ERR_LOG=$(mktemp)
trap 'rm -f "$ERR_LOG"' EXIT

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if INFO_JSON=$(xcrun notarytool info "$SUB_ID" "${NOTARY_ARGS[@]}" 2>"$ERR_LOG"); then
    CONSEC_FAILS=0
    STATUS=$(printf '%s' "$INFO_JSON" | jq -r .status)
    echo "[$(date -u +%H:%M:%SZ)] status=$STATUS"
    case "$STATUS" in
      Accepted)
        break
        ;;
      Invalid|Rejected)
        echo "::group::Notary log for $SUB_ID"
        xcrun notarytool log "$SUB_ID" "${NOTARY_ARGS[@]}" || true
        echo "::endgroup::"
        exit 1
        ;;
    esac
  else
    CONSEC_FAILS=$((CONSEC_FAILS + 1))
    echo "[$(date -u +%H:%M:%SZ)] poll failed (consec=$CONSEC_FAILS); retrying in 30s"
    # After 3 consecutive failures, dump stderr — likely a non-transient
    # auth/network issue and we should not silently wait the full 30 min.
    if [ "$CONSEC_FAILS" -ge 3 ]; then
      echo "::group::notarytool info stderr (last attempt)"
      cat "$ERR_LOG" || true
      echo "::endgroup::"
    fi
  fi
  sleep 30
done

if [ "$STATUS" != "Accepted" ]; then
  echo "ERROR: notarization did not complete within 30m (last status: $STATUS)" >&2
  echo "::group::Notary log for $SUB_ID (timeout)"
  xcrun notarytool log "$SUB_ID" "${NOTARY_ARGS[@]}" || true
  echo "::endgroup::"
  exit 1
fi

# Apple's CDN occasionally lags a few seconds behind notary acceptance,
# so `stapler staple` can return "Could not retrieve ticket after 3 tries"
# on the first attempt for a freshly-accepted submission. Retry briefly.
echo "Stapling $STAPLE_TARGET..."
STAPLE_OK=0
STAPLE_MAX=3
for attempt in $(seq 1 "$STAPLE_MAX"); do
  if xcrun stapler staple "$STAPLE_TARGET"; then
    STAPLE_OK=1
    break
  fi
  echo "stapler staple attempt $attempt failed"
  # Don't burn another 30s after the final attempt — fail fast.
  if [ "$attempt" -lt "$STAPLE_MAX" ]; then
    echo "sleeping 30s before retry"
    sleep 30
  fi
done
if [ "$STAPLE_OK" -ne 1 ]; then
  echo "ERROR: stapler staple failed after $STAPLE_MAX attempts" >&2
  exit 1
fi
xcrun stapler validate "$STAPLE_TARGET"
echo "OK: $STAPLE_TARGET notarized and stapled"
