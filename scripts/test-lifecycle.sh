#!/usr/bin/env bash
#
# test-lifecycle.sh — fire a realistic bracket-trade lifecycle through the proxy webhook.
#
# Mirrors the real strategy flow: BOTH brackets are placed and armed at the same
# time. When the winning side fills, the losing side's pending order is cancelled
# (cancel alert + entry_cancelled event), then the winner exits and closes.
#
# Usage:
#   ./scripts/test-lifecycle.sh <range_high> <range_low> [winner] [outcome]
#
#   range_high  Range top — long entry (stop) price and short stop-loss.
#   range_low   Range bottom — short entry (stop) price and long stop-loss.
#   winner      long | short | random   (default: random)
#   outcome     win | loss              (default: win — exit at TP; loss exits at the stop)
#
# Optional env overrides:
#   BASE_URL      Tunnel/local base URL          (default: ngrok tunnel)
#   PROXY_SECRET  Proxy webhook secret           (default: read from .env PROXY_WEBHOOK_SECRET)
#   TICKER        Ticker symbol                  (default: MNQ1!)
#   QUANTITY      Contracts                      (default: 25)
#   TARGET_POINTS Take-profit distance in points (default: 10, i.e. 40 MNQ ticks)
#   RANGE_NAME    Range name                     (default: Test Range)
#   SOURCE        extras.source tag              (default: lifecycle-test)
#   SLEEP_SECONDS Delay between calls            (default: 2)
#   FLATTEN_FIRST Send eod-cancel + eod-flatten for the routed account before
#                 the test run (default: 1; set 0 to skip). Cancels ALL orders
#                 and flattens ALL positions on the account — ticker-wide at
#                 TradersPost, not just this range.
#   DB_PATH       Local sqlite path for open order/position discovery
#                 (default: ../data/bridge.sqlite)

set -euo pipefail

RANGE_HIGH="${1:?usage: $0 <range_high> <range_low> [long|short|random] [win|loss]}"
RANGE_LOW="${2:?usage: $0 <range_high> <range_low> [long|short|random] [win|loss]}"
WINNER="${3:-random}"
OUTCOME="${4:-win}"

[ "$WINNER" = random ] && WINNER=$([ $((RANDOM % 2)) -eq 0 ] && echo long || echo short)
case "$WINNER" in long|short) ;; *) echo "error: winner must be long|short|random" >&2; exit 1;; esac
case "$OUTCOME" in win|loss) ;; *) echo "error: outcome must be win|loss" >&2; exit 1;; esac

BASE_URL="${BASE_URL:-https://5c18-2604-3d08-b174-a300-40cc-79b5-b6d2-7929.ngrok-free.app}"
TICKER="${TICKER:-MNQ1!}"
QUANTITY="${QUANTITY:-25}"
TARGET_POINTS="${TARGET_POINTS:-10}"
RANGE_NAME="${RANGE_NAME:-Test Range}"
SOURCE="${SOURCE:-lifecycle-test}"
SLEEP_SECONDS="${SLEEP_SECONDS:-2}"
MIN_TICK=0.25        # MNQ tick size
TICK_VALUE=0.50      # USD per tick per contract
FLATTEN_FIRST="${FLATTEN_FIRST:-1}"
DB_PATH="${DB_PATH:-$(cd "$(dirname "$0")/.." && pwd)/data/bridge.sqlite}"

PROXY_SECRET="${PROXY_SECRET:-}"
if [ -z "$PROXY_SECRET" ]; then
  ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
  PROXY_SECRET="$(grep -E '^PROXY_WEBHOOK_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
fi
[ -n "$PROXY_SECRET" ] || { echo "error: PROXY_WEBHOOK_SECRET not found (set env or .env)" >&2; exit 1; }

URL="$BASE_URL/proxy/$PROXY_SECRET"
UUID() { uuidgen | tr 'A-Z' 'a-z'; }
NOW_MS() { python3 -c 'import time; print(int(time.time()*1000))'; }
NOW_ISO() { python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z"))'; }
PY() { python3 -c "$1"; }

post() {
  local label="$1" body="$2"
  echo "→ $label"
  curl -sS --fail-with-body -w '\n   HTTP %{http_code}\n' -X POST "$URL" \
    -H 'content-type: application/json' --data "$body"
  sleep "$SLEEP_SECONDS"
}

# side params: side=long -> entry=RANGE_HIGH, sl=RANGE_LOW, tp=high+TARGET; short mirrors
setup_side() { # setup_side <long|short> ; sets S_ENTRY S_SL S_TP S_ACTION S_SENTIMENT
  if [ "$1" = long ]; then
    S_ENTRY="$RANGE_HIGH"; S_SL="$RANGE_LOW"; S_TP="$(PY "print(round($RANGE_HIGH + $TARGET_POINTS, 10))")"
    S_ACTION=buy; S_SENTIMENT=long
  else
    S_ENTRY="$RANGE_LOW"; S_SL="$RANGE_HIGH"; S_TP="$(PY "print(round($RANGE_LOW - $TARGET_POINTS, 10))")"
    S_ACTION=sell; S_SENTIMENT=short
  fi
}

order_payload() { # order_payload <side> <trade_id>
  setup_side "$1"
  local bracket_id="$2-bracket"
  printf '{"ticker":"%s","action":"%s","sentiment":"%s","quantity":%s,"quantityType":"fixed_quantity","price":%s,"signalPrice":%s,"orderType":"stop","stopPrice":%s,"bracketId":"%s","bracketSide":"%s","time":"%s","interval":"15S","takeProfit":{"limitPrice":%s},"stopLoss":{"type":"stop","stopPrice":%s},"extras":{"source":"%s","strategyStopPrice":%s,"strategyStopMode":"intrabar","orderRole":"range_bracket","orderLeg":"single","rangeName":"%s"}}' \
    "$TICKER" "$S_ACTION" "$S_SENTIMENT" "$QUANTITY" "$S_ENTRY" "$S_ENTRY" "$S_ENTRY" "$bracket_id" "$1" "$(NOW_MS)" "$S_TP" "$S_SL" "$SOURCE" "$S_SL" "$RANGE_NAME"
}

lifecycle_payload() { # lifecycle_payload <event_type> <trade_id> <side> <action> [extra_fields...]
  local event_type="$1" trade_id="$2" side="$3" action="$4"; shift 4
  local extras="\"source\":\"$SOURCE\",\"rangeName\":\"$RANGE_NAME\""
  printf '{"eventType":"%s","eventId":"%s-%s-leg-0","tradeId":"%s","ticker":"%s","side":"%s","action":"%s","quantity":%s%s,"occurredAt":"%s","extras":{%s}}' \
    "$event_type" "$trade_id" "$event_type" "$trade_id" "$TICKER" "$side" "$action" "$QUANTITY" "$*" "$(NOW_ISO)" "$extras"
}

LOSER=$([ "$WINNER" = long ] && echo short || echo long)
LONG_ID="$SOURCE-$(UUID)-long"
SHORT_ID="$SOURCE-$(UUID)-short"
WINNER_ID=$([ "$WINNER" = long ] && echo "$LONG_ID" || echo "$SHORT_ID")
LOSER_ID=$([ "$LOSER" = long ] && echo "$LONG_ID" || echo "$SHORT_ID")

# Winner exit price: TP on win, stop-loss on loss.
setup_side "$WINNER"; W_ENTRY="$S_ENTRY"; W_SL="$S_SL"; W_TP="$S_TP"; W_ACTION="$S_ACTION"
setup_side "$LOSER";  L_ENTRY="$S_ENTRY"; L_ACTION="$S_ACTION"
if [ "$OUTCOME" = win ]; then W_EXIT="$W_TP"; W_REASON=take_profit; else W_EXIT="$W_SL"; W_REASON=stop_loss; fi
read -r TICKS DOLLARS <<<"$(PY "m=($W_EXIT - $W_ENTRY) * (1 if '$WINNER'=='long' else -1); print(round(m/$MIN_TICK,10), round(m/$MIN_TICK*$TICK_VALUE*$QUANTITY,2))")"

echo "Range: $RANGE_NAME [$RANGE_LOW – $RANGE_HIGH] | winner: $WINNER ($OUTCOME) | loser: $LOSER (cancelled)"
echo

# ── 0. Flatten the routed account (orders + positions, ticker-wide) ───────────
if [ "$FLATTEN_FIRST" = 1 ]; then
  ACCOUNT_ID="$(sqlite3 "$DB_PATH" "SELECT account_id FROM range_routes WHERE range_name='$RANGE_NAME' LIMIT 1")"
  if [ -z "$ACCOUNT_ID" ]; then
    echo "warn: no route found for range '$RANGE_NAME' — skipping flatten"
  else
    echo "Flatten preamble — account $ACCOUNT_ID (eod_cancel_all / eod_flatten bypass the unrelated-order guards)"

    # Open orders: delivered/pending buy/sell alerts with no fill or cancel recorded.
    OPEN_ORDER_TICKERS="$(sqlite3 "$DB_PATH" "
      SELECT DISTINCT pa.ticker FROM proxy_deliveries pd
      JOIN proxy_alerts pa ON pa.id = pd.proxy_alert_id
      WHERE pd.account_id = '$ACCOUNT_ID'
        AND pa.action IN ('buy','sell')
        AND (pd.status LIKE '%pending%' OR pd.status LIKE '%delivered%' OR pd.status = 'extension_draft_created')
        AND NOT EXISTS (
          SELECT 1 FROM range_trade_events rte
          WHERE (rte.trade_id = pa.source_reference
                 OR rte.trade_id LIKE (pa.source_reference || '-lifecycle-%'))
            AND rte.event_type IN ('entry_filled','entry_cancelled'))")"
    for t in $OPEN_ORDER_TICKERS; do
      post "CANCEL ALL orders: $t" \
        "{\"ticker\":\"$t\",\"action\":\"cancel\",\"time\":\"$(NOW_MS)\",\"interval\":\"1\",\"extras\":{\"reason\":\"eod_cancel_all\",\"source\":\"$SOURCE\",\"rangeName\":\"$RANGE_NAME\"}}"
    done
    [ -z "$OPEN_ORDER_TICKERS" ] && echo "   (no open orders)"

    # Open positions: net quantity > 0 in trade_events.
    OPEN_POSITIONS="$(sqlite3 "$DB_PATH" "
      SELECT instrument FROM trade_events
      WHERE account_id = '$ACCOUNT_ID'
        AND event_type IN ('entry_filled','exit_filled','trade_closed')
      GROUP BY instrument
      HAVING SUM(CASE WHEN event_type='entry_filled' THEN quantity ELSE -quantity END) > 0")"
    for t in $OPEN_POSITIONS; do
      post "FLATTEN position: $t" \
        "{\"ticker\":\"$t\",\"action\":\"exit\",\"orderType\":\"market\",\"sentiment\":\"flat\",\"time\":\"$(NOW_MS)\",\"interval\":\"1\",\"extras\":{\"reason\":\"eod_flatten\",\"source\":\"$SOURCE\",\"rangeName\":\"$RANGE_NAME\"}}"
    done
    [ -z "$OPEN_POSITIONS" ] && echo "   (no open positions)"
    echo
  fi
fi

# ── 1. Both brackets placed + armed simultaneously ────────────────────────────
post "long order (buy stop @$RANGE_HIGH)"  "$(order_payload long  "$LONG_ID")"
post "short order (sell stop @$RANGE_LOW)" "$(order_payload short "$SHORT_ID")"
post "long entry_armed"  "$(lifecycle_payload entry_armed "$LONG_ID"  long  buy)"
post "short entry_armed" "$(lifecycle_payload entry_armed "$SHORT_ID" short sell)"

# ── 2. Winner fills; loser order cancelled + entry_cancelled ──────────────────
post "$WINNER entry_filled @$W_ENTRY" \
  "$(lifecycle_payload entry_filled "$WINNER_ID" "$WINNER" "$W_ACTION" ",\"entryPrice\":$W_ENTRY")"

post "$LOSER order cancelled" \
  "{\"ticker\":\"$TICKER\",\"action\":\"cancel\",\"cancelOrderType\":\"stop\",\"bracketId\":\"$LOSER_ID-bracket\",\"bracketSide\":\"$LOSER\",\"time\":\"$(NOW_MS)\",\"interval\":\"15S\",\"extras\":{\"reason\":\"bracket_cancel_pending_order\",\"source\":\"$SOURCE\",\"rangeName\":\"$RANGE_NAME\"}}"

post "$LOSER entry_cancelled" \
  "$(lifecycle_payload entry_cancelled "$LOSER_ID" "$LOSER" cancel ",\"entryPrice\":$L_ENTRY")"

# ── 3. Winner exits and closes ────────────────────────────────────────────────
post "$WINNER exit_filled @$W_EXIT ($W_REASON)" \
  "{\"eventType\":\"exit_filled\",\"eventId\":\"$WINNER_ID-exit_filled-leg-1\",\"tradeId\":\"$WINNER_ID\",\"ticker\":\"$TICKER\",\"side\":\"$WINNER\",\"action\":\"exit\",\"quantity\":$QUANTITY,\"exitPrice\":$W_EXIT,\"occurredAt\":\"$(NOW_ISO)\",\"extras\":{\"source\":\"$SOURCE\",\"rangeName\":\"$RANGE_NAME\",\"exitReason\":\"$W_REASON\"}}"

post "$WINNER trade_closed ($OUTCOME, $TICKS ticks, \$$DOLLARS)" \
  "{\"eventType\":\"trade_closed\",\"eventId\":\"$WINNER_ID-trade_closed-leg-1\",\"tradeId\":\"$WINNER_ID\",\"ticker\":\"$TICKER\",\"side\":\"$WINNER\",\"action\":\"exit\",\"quantity\":$QUANTITY,\"entryPrice\":$W_ENTRY,\"exitPrice\":$W_EXIT,\"closedAt\":\"$(NOW_ISO)\",\"realizedTicks\":$TICKS,\"realizedDollars\":$DOLLARS,\"outcome\":\"$OUTCOME\",\"extras\":{\"source\":\"$SOURCE\",\"rangeName\":\"$RANGE_NAME\",\"exitReason\":\"$W_REASON\"}}"

echo
echo "done. winner trade_id: $WINNER_ID"
