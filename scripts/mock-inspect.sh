#!/usr/bin/env bash
# Inspect the mock TradersPost receiver after running the Pine test scripts.
# Point the account destination webhook at http://localhost:3000/mock/traderspost
# (optionally with ?mode=reject / ?mode=error&status=503 / ?mode=timeout / ?delay=ms),
# then use this to compare what the bridge actually dispatched.
#
# Usage:
#   ./scripts/mock-inspect.sh [calls|state|clear] [BASE_URL]
set -euo pipefail

BASE_URL="${2:-${BASE_URL:-http://localhost:3000}}"
COMMAND="${1:-calls}"

case "$COMMAND" in
  calls) curl -sS "$BASE_URL/mock/traderspost/calls" ;;
  state) curl -sS "$BASE_URL/mock/traderspost/state" ;;
  clear) curl -sS -X POST "$BASE_URL/mock/traderspost/clear" ;;
  *) echo "usage: $0 [calls|state|clear] [BASE_URL]" >&2; exit 1 ;;
esac | python3 -m json.tool
