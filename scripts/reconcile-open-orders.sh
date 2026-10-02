#!/usr/bin/env bash
#
# reconcile-open-orders.sh — send entry_cancelled lifecycle events for every
# order the local DB still considers open, so bookkeeping matches the broker.
#
# Usage:
#   ./scripts/reconcile-open-orders.sh [account_id]
#
#   account_id  defaults to the account routed by RANGE_NAME (Test Range).
#
# Env: BASE_URL, PROXY_SECRET, RANGE_NAME, SOURCE, SLEEP_SECONDS, DB_PATH
# (same defaults as test-lifecycle.sh)

set -euo pipefail

RANGE_NAME="${RANGE_NAME:-Test Range}"
BASE_URL="${BASE_URL:-https://5c18-2604-3d08-b174-a300-40cc-79b5-b6d2-7929.ngrok-free.app}"
SOURCE="${SOURCE:-lifecycle-test}"
SLEEP_SECONDS="${SLEEP_SECONDS:-1}"
DB_PATH="${DB_PATH:-$(cd "$(dirname "$0")/.." && pwd)/data/bridge.sqlite}"

ACCOUNT_ID="${1:-$(sqlite3 "$DB_PATH" "SELECT account_id FROM range_routes WHERE range_name='$RANGE_NAME' LIMIT 1")}"
[ -n "$ACCOUNT_ID" ] || { echo "error: no route/account found" >&2; exit 1; }

if [ -z "${PROXY_SECRET:-}" ]; then
  PROXY_SECRET=$(grep -E '^PROXY_WEBHOOK_SECRET=' "$(dirname "$0")/../.env" | head -1 | cut -d= -f2- | tr -d '\r"'\''')
fi
[ -n "$PROXY_SECRET" ] || { echo "error: PROXY_WEBHOOK_SECRET not found" >&2; exit 1; }
URL="$BASE_URL/proxy/$PROXY_SECRET"

NOW_ISO() { python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z"))'; }

# Stale open orders: delivered/pending buy/sell deliveries with no fill or cancel event.
sqlite3 -separator '|' "$DB_PATH" "
  SELECT pa.source_reference, pa.ticker, pa.action, pa.range_name,
         json_extract(pa.payload_json, '$.quantity'),
         json_extract(pa.payload_json, '$.bracketSide')
  FROM proxy_deliveries pd
  JOIN proxy_alerts pa ON pa.id = pd.proxy_alert_id
  WHERE pd.account_id = '$ACCOUNT_ID'
    AND pa.action IN ('buy','sell')
    AND pa.source_reference IS NOT NULL
    AND (pd.status LIKE '%pending%' OR pd.status LIKE '%delivered%' OR pd.status = 'extension_draft_created')
    AND NOT EXISTS (
      SELECT 1 FROM range_trade_events rte
      WHERE (rte.trade_id = pa.source_reference
             OR rte.trade_id LIKE (pa.source_reference || '-lifecycle-%'))
        AND rte.event_type IN ('entry_filled','entry_cancelled'))
" | while IFS='|' read -r ref ticker action range qty side; do
    [ -n "$side" ] || side=$([ "$action" = buy ] && echo long || echo short)
    [ -n "$qty" ] || qty=1
    range="${range:-$RANGE_NAME}"
    echo "→ entry_cancelled $ref ($side $ticker x$qty @ $range)"
    curl -sS -w '\n   HTTP %{http_code}\n' -X POST "$URL" \
      -H 'content-type: application/json' --data \
      "{\"eventType\":\"entry_cancelled\",\"eventId\":\"$ref-entry_cancelled-leg-0\",\"tradeId\":\"$ref\",\"ticker\":\"$ticker\",\"side\":\"$side\",\"action\":\"cancel\",\"quantity\":$qty,\"occurredAt\":\"$(NOW_ISO)\",\"extras\":{\"source\":\"$SOURCE\",\"rangeName\":\"$range\",\"reason\":\"reconcile_stale_order\"}}"
    sleep "$SLEEP_SECONDS"
done

echo "done."
