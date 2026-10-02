#!/usr/bin/env bash
# Mark one side of the armed test range as filled.
#
# Usage:
#   ./scripts/02-entry-filled.sh [long|short] [TRADE_ID]
#   RANGE_PROFILE=v3x ./scripts/02-entry-filled.sh short
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/pine-test-common.sh"

SIDE="${1:-long}"
TRADE_ID="${2:-}"
[ -n "$TRADE_ID" ] || TRADE_ID=$(range_trade_id "$SIDE")

case "$SIDE" in
  long) ACTION=buy ;;
  short) ACTION=sell ;;
  *) echo "usage: $0 [long|short] [TRADE_ID]" >&2; exit 1 ;;
esac

ENTRY_PRICE=$(entry_price "$SIDE")

payload=$(printf '{"eventType":"entry_filled","eventId":"%s-entry_filled-leg-0","tradeId":"%s","ticker":"%s","side":"%s","action":"%s","quantity":%s,"entryPrice":%s,"occurredAt":"%s","extras":{"source":"ultra-v5.3-test","rangeName":"%s"}}' \
  "$TRADE_ID" "$TRADE_ID" "$TICKER" "$SIDE" "$ACTION" "$QUANTITY" "$ENTRY_PRICE" "$(now_iso)" "$RANGE_NAME")

post "ENTRY_FILLED $SIDE ($TRADE_ID)" "$payload"
