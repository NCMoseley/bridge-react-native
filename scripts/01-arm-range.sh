#!/usr/bin/env bash
# Form the test range by sending both sides: order payload + entry_armed for long and short.
# This is what ULTRA does when the range is first established.
#
# Usage:
#   ./scripts/01-arm-range.sh
#   RANGE_PROFILE=v3x ./scripts/01-arm-range.sh   # profiles in scripts/ranges/
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/pine-test-common.sh"

LONG_ID=$(range_trade_id long)
SHORT_ID=$(range_trade_id short)

echo "Arming test range: $RANGE_NAME on $TICKER"
echo "  long tradeId:  $LONG_ID"
echo "  short tradeId: $SHORT_ID"
echo "  long:  entry $(entry_price long)  TP $(tp_price long)  SL $(sl_price long)"
echo "  short: entry $(entry_price short) TP $(tp_price short) SL $(sl_price short)"
echo ""

send_side() {
  local side="$1" id="$2"
  local action bracket_id entry tp sl
  case "$side" in
    long) action=buy ;;
    short) action=sell ;;
  esac
  bracket_id=$(range_arm_id "$side")
  entry=$(entry_price "$side")
  tp=$(tp_price "$side")
  sl=$(sl_price "$side")

  local order
  order=$(printf '{"ticker":"%s","action":"%s","quantity":%s,"quantityType":"fixed_quantity","price":%s,"signalPrice":%s,"orderType":"stop","stopPrice":%s,"bracketId":"%s","bracketSide":"%s","tradeId":"%s","time":"%s","interval":"15S","takeProfit":{"limitPrice":%s},"stopLoss":{"type":"stop","stopPrice":%s},"extras":{"source":"ultra-v5.3-test","strategyStopPrice":%s,"strategyStopMode":"intrabar","orderRole":"range_bracket","orderLeg":"single","rangeName":"%s"}}' \
    "$TICKER" "$action" "$QUANTITY" "$entry" "$entry" "$entry" "$bracket_id" "$side" "$id" "$(now_ms)" "$tp" "$sl" "$sl" "$RANGE_NAME")
  post "ORDER $side ($id)" "$order"

  local armed
  armed=$(printf '{"eventType":"entry_armed","eventId":"%s-entry_armed-leg-0","tradeId":"%s","ticker":"%s","side":"%s","action":"%s","quantity":%s,"entryPrice":%s,"occurredAt":"%s","extras":{"source":"ultra-v5.3-test","rangeName":"%s"}}' \
    "$id" "$id" "$TICKER" "$side" "$action" "$QUANTITY" "$entry" "$(now_iso)" "$RANGE_NAME")
  post "ENTRY_ARMED $side ($id)" "$armed"
}

send_side long "$LONG_ID"
send_side short "$SHORT_ID"
