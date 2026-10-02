#!/usr/bin/env bash
set -euo pipefail

# Shared config and helpers for the Pine test scripts.
# This file is meant to be sourced, not run directly.

COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$COMMON_DIR/pine-test-config.sh"

# Optional per-range profile: scripts/ranges/<name>.sh overrides the defaults
# above (TICKER, RANGE_NAME, RANGE_HIGH/LOW, TP_OFFSET, STOP_OFFSET, QUANTITY).
# Run with e.g. RANGE_PROFILE=v3x ./scripts/01-arm-range.sh
if [ -n "${RANGE_PROFILE:-}" ]; then
  PROFILE_FILE="$COMMON_DIR/ranges/$(echo "$RANGE_PROFILE" | tr '[:upper:]' '[:lower:]').sh"
  [ -r "$PROFILE_FILE" ] || { echo "error: no range profile at $PROFILE_FILE" >&2; exit 1; }
  source "$PROFILE_FILE"
fi

ENV_FILE="${ENV_FILE:-$COMMON_DIR/../.env}"
PROXY_SECRET="${PROXY_SECRET:-${PROXY_WEBHOOK_SECRET:-}}"
if [ -z "$PROXY_SECRET" ] && [ -r "$ENV_FILE" ]; then
  PROXY_SECRET="$(grep -E '^PROXY_WEBHOOK_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"\r')"
fi
[ -n "$PROXY_SECRET" ] || { echo "error: PROXY_WEBHOOK_SECRET not found (set env or .env)" >&2; exit 1; }

URL="$BASE_URL/proxy/$PROXY_SECRET"
RUN_FILE="/tmp/pine-test-run"

uuid() { uuidgen | tr 'A-Z' 'a-z'; }
now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
now_iso() { python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z"))'; }

ensure_run() {
  if [ -n "${PINE_TEST_RUN:-}" ]; then
    return
  elif [ -s "$RUN_FILE" ]; then
    PINE_TEST_RUN="$(cat "$RUN_FILE")"
  else
    PINE_TEST_RUN="$(date +%s)"
    echo "$PINE_TEST_RUN" > "$RUN_FILE"
  fi
}

# Bracket/arm id — matches ULTRA's bracketId shape (order payload source_reference).
range_arm_id() {
  ensure_run
  local suffix="$1"
  [ -n "${RANGE_PROFILE:-}" ] && suffix="${RANGE_PROFILE}-${suffix}"
  echo "pine-test-$PINE_TEST_RUN-${suffix}-arm-1"
}

# Lifecycle tradeId — matches ULTRA's lifecycleBracketTradeId: "<armId>-lifecycle-<side>-0".
# Must keep the arm id as a prefix: the Open Orders delivery join relies on
# tradeId LIKE bracketId || '%'.
range_trade_id() {
  echo "$(range_arm_id "$1")-lifecycle-$1-0"
}

entry_price() {
  case "$1" in
    long) echo "$RANGE_HIGH" ;;
    short) echo "$RANGE_LOW" ;;
    *) echo "error: unknown side $1" >&2; exit 1 ;;
  esac
}

tp_price() {
  case "$1" in
    long) echo "$((RANGE_HIGH + TP_OFFSET))" ;;
    short) echo "$((RANGE_LOW - TP_OFFSET))" ;;
    *) echo "error: unknown side $1" >&2; exit 1 ;;
  esac
}

sl_price() {
  case "$1" in
    long) echo "$((RANGE_HIGH - STOP_OFFSET))" ;;
    short) echo "$((RANGE_LOW + STOP_OFFSET))" ;;
    *) echo "error: unknown side $1" >&2; exit 1 ;;
  esac
}

post() {
  local label="$1" body="$2"
  echo "→ $label"
  echo "$body" | sed 's/^/  /'
  curl -sS --fail-with-body -w '\n  HTTP %{http_code}\n' -X POST "$URL" \
    -H 'content-type: application/json' --data "$body"
}
