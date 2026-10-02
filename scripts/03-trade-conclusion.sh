#!/usr/bin/env bash
# Close the filled side of the test range and trigger the reapply workflow.
# The conclusion can be tp (take-profit win), sl (stop-loss loss), or be (breakeven).
#
# Usage:
#   ./scripts/03-trade-conclusion.sh [long|short] [tp|be|sl] [TRADE_ID]
#   RANGE_PROFILE=v3x ./scripts/03-trade-conclusion.sh short tp
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/pine-test-common.sh"

SIDE="${1:-long}"
CONCLUSION="${2:-tp}"
TRADE_ID="${3:-}"
[ -n "$TRADE_ID" ] || TRADE_ID=$(range_trade_id "$SIDE")

case "$SIDE" in
  long) ACTION=buy ;;
  short) ACTION=sell ;;
  *) echo "usage: $0 [long|short] [tp|be|sl] [TRADE_ID]" >&2; exit 1 ;;
esac

case "$(echo "$CONCLUSION" | tr '[:upper:]' '[:lower:]')" in
  tp)  EXIT_PRICE=$(tp_price "$SIDE"); OUTCOME=win;  EXIT_REASON=take_profit;  CANCEL_REASON=opposite_suppressed_after_tp ;;
  sl)  EXIT_PRICE=$(sl_price "$SIDE"); OUTCOME=loss; EXIT_REASON=stop_loss;  CANCEL_REASON=range_entry_capacity_reached ;;
  be)  EXIT_PRICE=$(entry_price "$SIDE"); OUTCOME=breakeven; EXIT_REASON=protected_stop; CANCEL_REASON=range_entry_capacity_reached ;;
  *) echo "usage: $0 [long|short] [tp|be|sl] [TRADE_ID]" >&2; exit 1 ;;
esac

ENTRY_PRICE=$(entry_price "$SIDE")

case "$SIDE" in
  long)  PRICE_DELTA=$((EXIT_PRICE - ENTRY_PRICE)) ;;
  short) PRICE_DELTA=$((ENTRY_PRICE - EXIT_PRICE)) ;;
esac
REALIZED_TICKS=$((PRICE_DELTA * TICKS_PER_POINT))
REALIZED_DOLLARS=$((REALIZED_TICKS * TICK_VALUE_CENTS * QUANTITY / 100))

[ "$OUTCOME" = breakeven ] && { REALIZED_TICKS=0; REALIZED_DOLLARS=0; }

payload=$(printf '{"eventType":"trade_closed","eventId":"%s-trade_closed-leg-1","tradeId":"%s","ticker":"%s","side":"%s","action":"exit","quantity":%s,"closedAt":"%s","realizedTicks":%s,"realizedDollars":%s,"outcome":"%s","entryPrice":%s,"exitPrice":%s,"extras":{"source":"ultra-v5.3-test","rangeName":"%s","exitReason":"%s"}}' \
  "$TRADE_ID" "$TRADE_ID" "$TICKER" "$SIDE" "$QUANTITY" "$(now_iso)" "$REALIZED_TICKS" "$REALIZED_DOLLARS" "$OUTCOME" "$ENTRY_PRICE" "$EXIT_PRICE" "$RANGE_NAME" "$EXIT_REASON")

post "TRADE_CLOSED $SIDE $CONCLUSION ($TRADE_ID)" "$payload"

# Real ULTRA retires the opposite arm on a close: send entry_cancelled for it too.
case "$SIDE" in
  long)  OPP_SIDE=short ;;
  short) OPP_SIDE=long ;;
esac
OPP_TRADE_ID=$(range_trade_id "$OPP_SIDE")
cancelled=$(printf '{"eventType":"entry_cancelled","eventId":"%s-entry_cancelled-leg-0","tradeId":"%s","ticker":"%s","side":"%s","action":"cancel","quantity":%s,"occurredAt":"%s","extras":{"source":"ultra-v5.3-test","rangeName":"%s","cancelReason":"%s"}}' \
  "$OPP_TRADE_ID" "$OPP_TRADE_ID" "$TICKER" "$OPP_SIDE" "$QUANTITY" "$(now_iso)" "$RANGE_NAME" "$CANCEL_REASON")
post "ENTRY_CANCELLED $OPP_SIDE ($OPP_TRADE_ID)" "$cancelled"
