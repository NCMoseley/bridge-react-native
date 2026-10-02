#!/usr/bin/env bash
#
# reconcile-open-positions.sh — simulate an EOD flatten in the local books:
# post exit_filled + trade_closed (breakeven) lifecycle events for every
# position the local DB still considers open.
#
# Usage:
#   ./scripts/reconcile-open-positions.sh [account_id]
#
# Env: BASE_URL, PROXY_SECRET, RANGE_NAME, SOURCE, SLEEP_SECONDS, DB_PATH,
#      INCLUDE_CRYPTO=1 (default: skip crypto roots; set 1 to close them too)

set -euo pipefail

RANGE_NAME="${RANGE_NAME:-Test Range}"
BASE_URL="${BASE_URL:-https://5c18-2604-3d08-b174-a300-40cc-79b5-b6d2-7929.ngrok-free.app}"
SOURCE="${SOURCE:-lifecycle-test}"
SLEEP_SECONDS="${SLEEP_SECONDS:-1}"
INCLUDE_CRYPTO="${INCLUDE_CRYPTO:-0}"
DB_PATH="${DB_PATH:-$(cd "$(dirname "$0")/.." && pwd)/data/bridge.sqlite}"

ACCOUNT_ID="${1:-$(sqlite3 "$DB_PATH" "SELECT account_id FROM range_routes WHERE range_name='$RANGE_NAME' LIMIT 1")}"
[ -n "$ACCOUNT_ID" ] || { echo "error: no route/account found" >&2; exit 1; }

if [ -z "${PROXY_SECRET:-}" ]; then
  PROXY_SECRET=$(grep -E '^PROXY_WEBHOOK_SECRET=' "$(dirname "$0")/../.env" | head -1 | cut -d= -f2- | tr -d '\r"'\''')
fi
[ -n "$PROXY_SECRET" ] || { echo "error: PROXY_WEBHOOK_SECRET not found" >&2; exit 1; }
URL="$BASE_URL/proxy/$PROXY_SECRET"

NOW_ISO() { python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z"))'; }

sqlite3 -separator '|' "$DB_PATH" "
  SELECT t.range_name, t.trade_id, t.instrument, t.side,
         SUM(CASE WHEN t.event_type='entry_filled' THEN t.quantity ELSE -t.quantity END) AS open_qty,
         MAX(CASE WHEN t.event_type='entry_filled' THEN t.entry_price END) AS entry_price
  FROM trade_events t
  WHERE t.account_id='$ACCOUNT_ID'
    AND t.event_type IN ('entry_filled','exit_filled','trade_closed')
  GROUP BY t.range_name, t.trade_id, t.instrument, t.side
  HAVING open_qty > 0
" | while IFS='|' read -r range trade_id ticker side qty entry_price; do
    root=$(echo "$ticker" | sed -E 's/^([A-Z]+).*/\1/')
    case "$root" in BTC|MBT|ETH|MET|SOL|XRP)
      if [ "$INCLUDE_CRYPTO" != "1" ]; then echo "→ skip crypto $ticker"; continue; fi ;;
    esac
    price_json="null"; [ -n "$entry_price" ] && [ "$entry_price" != "None" ] && price_json="$entry_price"
    range="${range:-$RANGE_NAME}"
    echo "→ flatten $trade_id ($side $ticker x$qty @ $range, entry $entry_price)"

    # trade_ids may contain control chars (\r etc.) — build JSON via python so they escape properly
    TRADE_ID="$trade_id" TICKER="$ticker" SIDE="$side" QTY="$qty" PRICE="$price_json" RANGE="$range" \
      NOW="$(NOW_ISO)" SRC="$SOURCE" python3 - <<'PY' > /tmp/eod_exit.json
import json, os
p = {"eventType": "exit_filled", "eventId": os.environ["TRADE_ID"] + "-eod_exit_filled",
     "tradeId": os.environ["TRADE_ID"], "ticker": os.environ["TICKER"], "side": os.environ["SIDE"],
     "action": "exit", "quantity": float(os.environ["QTY"]), "occurredAt": os.environ["NOW"],
     "extras": {"source": os.environ["SRC"], "rangeName": os.environ["RANGE"], "reason": "eod_flatten_reconcile"}}
if os.environ["PRICE"] != "null": p["exitPrice"] = float(os.environ["PRICE"])
print(json.dumps(p))
PY
    curl -sS -w '\n   exit_filled HTTP %{http_code}\n' -X POST "$URL" \
      -H 'content-type: application/json' --data @/tmp/eod_exit.json
    sleep "$SLEEP_SECONDS"

    TRADE_ID="$trade_id" TICKER="$ticker" SIDE="$side" QTY="$qty" PRICE="$price_json" RANGE="$range" \
      NOW="$(NOW_ISO)" SRC="$SOURCE" python3 - <<'PY' > /tmp/eod_close.json
import json, os
p = {"eventType": "trade_closed", "eventId": os.environ["TRADE_ID"] + "-eod_trade_closed",
     "tradeId": os.environ["TRADE_ID"], "ticker": os.environ["TICKER"], "side": os.environ["SIDE"],
     "action": "exit", "quantity": float(os.environ["QTY"]),
     "realizedTicks": 0, "realizedDollars": 0, "outcome": "breakeven",
     "closedAt": os.environ["NOW"],
     "extras": {"source": os.environ["SRC"], "rangeName": os.environ["RANGE"],
                "reason": "eod_flatten_reconcile", "exitReason": "eod_flatten"}}
if os.environ["PRICE"] != "null":
    p["entryPrice"] = float(os.environ["PRICE"]); p["exitPrice"] = float(os.environ["PRICE"])
print(json.dumps(p))
PY
    curl -sS -w '\n   trade_closed HTTP %{http_code}\n' -X POST "$URL" \
      -H 'content-type: application/json' --data @/tmp/eod_close.json
    sleep "$SLEEP_SECONDS"
done

echo "done."
