#!/usr/bin/env bash
set -euo pipefail

# Simulate the ULTRA v5.1 lifecycle alerts for the Test Range.
# Update the variables at the top, then run:
#   PROXY_SECRET=<your-proxy-secret> ./simulate-ultra.sh
# To expose through an ngrok or cloudflared tunnel:
#   TUNNEL=true ./simulate-ultra.sh
#
# Requires: curl, a running Bridge server, and PROXY_SECRET matching
# PROXY_WEBHOOK_SECRET used by the server.

# ---- User-editable variables ----
TICKER="${TICKER:-MNQ1!}"
RANGE_NAME="${RANGE_NAME:-Test Range}"
QUANTITY="${QUANTITY:-1}"

# Range boundaries -- edit these manually for each run
RANGE_HIGH="${RANGE_HIGH:-29472}"
RANGE_LOW="${RANGE_LOW:-29147}"

# Long = buy stop at the low, take-profit at the high
LONG_ENTRY="${LONG_ENTRY:-$RANGE_LOW}"
LONG_EXIT="${LONG_EXIT:-$RANGE_HIGH}"

# Short = sell stop at the high (stays armed; cancelled when long fills)
SHORT_ENTRY="${SHORT_ENTRY:-$RANGE_HIGH}"

# Tick value in dollars for realized dollar math (edit for the instrument)
TICK_VALUE="${TICK_VALUE:-5}"

# Delay between simulated lifecycle steps (default 2 seconds)
STEP_DELAY="${STEP_DELAY:-2}"

# Server / tunnel settings
PROXY_SECRET="${PROXY_SECRET:-${PROXY_WEBHOOK_SECRET:-}}"
BASE_URL="${BASE_URL:-}"
TUNNEL="${TUNNEL:-false}"

# ---- Computed helpers ----
TIMESTAMP="$(date +%s)"
TRADE_ID_LONG="ultra-sim-${TICKER}-${TIMESTAMP}-long-arm-0-lifecycle-long-0"
TRADE_ID_SHORT="ultra-sim-${TICKER}-${TIMESTAMP}-short-arm-0-lifecycle-short-0"

if command -v node >/dev/null 2>&1; then
  REALIZED_TICKS="$(node -e "console.log(${LONG_EXIT} - ${LONG_ENTRY})")"
  REALIZED_DOLLARS="$(node -e "console.log((${LONG_EXIT} - ${LONG_ENTRY}) * ${TICK_VALUE})")"
else
  echo "Warning: Node.js not found. Using 0 for realizedTicks/realizedDollars." >&2
  REALIZED_TICKS="0"
  REALIZED_DOLLARS="0"
fi

OCCURRED_AT="$(date -u +%FT%T.000Z)"

# ---- Validate ----
if [[ -z "$PROXY_SECRET" ]]; then
  echo "Error: PROXY_SECRET (or PROXY_WEBHOOK_SECRET) is required." >&2
  echo "Set it in your environment or .env before running this script." >&2
  exit 1
fi

if [[ -z "$BASE_URL" && "$TUNNEL" == "true" ]]; then
  if command -v ngrok >/dev/null 2>&1; then
    echo "Starting ngrok tunnel..."
    ngrok http 3000 >/tmp/ngrok.log 2>&1 &
    NGROK_PID=$!
    cleanup() { kill "$NGROK_PID" 2>/dev/null || true; }
    trap cleanup EXIT
    for _ in $(seq 1 20); do
      if curl -fsS http://127.0.0.1:4040/api/tunnels >/tmp/ngrok.json 2>/dev/null; then
        if command -v python3 >/dev/null 2>&1; then
          BASE_URL="$(python3 -c 'import sys,json; d=json.load(open("/tmp/ngrok.json")); print(d["tunnels"][0]["public_url"])')"
        elif command -v jq >/dev/null 2>&1; then
          BASE_URL="$(jq -r '.tunnels[0].public_url' /tmp/ngrok.json)"
        fi
        [[ -n "$BASE_URL" ]] && break
      fi
      sleep 1
    done
    if [[ -z "$BASE_URL" ]]; then
      echo "Error: ngrok did not expose a URL in time." >&2
      exit 1
    fi
    echo "Tunnel ready: $BASE_URL"
  elif command -v cloudflared >/dev/null 2>&1; then
    echo "Starting cloudflared tunnel..."
    cloudflared tunnel --url "http://localhost:3000" >/tmp/cloudflared.log 2>&1 &
    CLOUDFLARED_PID=$!
    cleanup() { kill "$CLOUDFLARED_PID" 2>/dev/null || true; }
    trap cleanup EXIT
    for _ in $(seq 1 20); do
      BASE_URL="$(grep -m1 -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' /tmp/cloudflared.log | head -n1 || true)"
      [[ -n "$BASE_URL" ]] && break
      sleep 1
    done
    if [[ -z "$BASE_URL" ]]; then
      echo "Error: cloudflared did not expose a URL in time." >&2
      exit 1
    fi
    echo "Tunnel ready: $BASE_URL"
  else
    echo "Error: TUNNEL=true but neither ngrok nor cloudflared was found." >&2
    exit 1
  fi
fi

BASE_URL="${BASE_URL:-http://localhost:3000}"
PROXY_URL="${BASE_URL}/proxy/${PROXY_SECRET}"

echo "Sending ULTRA lifecycle simulation to: $PROXY_URL"
echo "  Ticker: $TICKER"
echo "  Range: $RANGE_NAME"
echo "  Long entry: $LONG_ENTRY  -> exit: $LONG_EXIT (realized $REALIZED_TICKS ticks / \$${REALIZED_DOLLARS})"
echo ""

send() {
  local name="$1"
  local payload="$2"
  local tmp
  tmp="$(mktemp)"
  echo "$payload" > "$tmp"
  echo "--- $name ---"
  echo "$payload" | sed 's/^/  /'
  curl -fsS -X POST "$PROXY_URL" -H "content-type: application/json" --data-binary "@$tmp" | sed 's/^/  -> /'
  echo ""
  rm -f "$tmp"
}

# 1. Arm the long stop (buy stop at LONG_ENTRY)
send "entry_armed (long)" "$(cat <<EOF
{
  "eventType": "entry_armed",
  "eventId": "entry_armed-${TRADE_ID_LONG}-leg-0",
  "tradeId": "${TRADE_ID_LONG}",
  "ticker": "${TICKER}",
  "side": "long",
  "quantity": ${QUANTITY},
  "action": "buy",
  "orderType": "stop",
  "entryPrice": ${LONG_ENTRY},
  "stopPrice": ${LONG_ENTRY},
  "extras": { "rangeName": "${RANGE_NAME}" }
}
EOF
)"
sleep "$STEP_DELAY"

# 2. Arm the short stop (sell stop at SHORT_ENTRY)
send "entry_armed (short)" "$(cat <<EOF
{
  "eventType": "entry_armed",
  "eventId": "entry_armed-${TRADE_ID_SHORT}-leg-0",
  "tradeId": "${TRADE_ID_SHORT}",
  "ticker": "${TICKER}",
  "side": "short",
  "quantity": ${QUANTITY},
  "action": "sell",
  "orderType": "stop",
  "entryPrice": ${SHORT_ENTRY},
  "stopPrice": ${SHORT_ENTRY},
  "extras": { "rangeName": "${RANGE_NAME}" }
}
EOF
)"

# 3. Long fills at the entry price
sleep "$STEP_DELAY"
send "entry_filled (long)" "$(cat <<EOF
{
  "eventType": "entry_filled",
  "eventId": "entry_filled-${TRADE_ID_LONG}-leg-0",
  "tradeId": "${TRADE_ID_LONG}",
  "ticker": "${TICKER}",
  "side": "long",
  "quantity": ${QUANTITY},
  "action": "buy",
  "entryPrice": ${LONG_ENTRY},
  "extras": { "rangeName": "${RANGE_NAME}" },
  "occurredAt": "${OCCURRED_AT}"
}
EOF
)"

# 4. Opposing short arm is cancelled
sleep "$STEP_DELAY"
send "entry_cancelled (short)" "$(cat <<EOF
{
  "eventType": "entry_cancelled",
  "eventId": "entry_cancelled-${TRADE_ID_SHORT}-leg-0",
  "tradeId": "${TRADE_ID_SHORT}",
  "ticker": "${TICKER}",
  "side": "short",
  "quantity": ${QUANTITY},
  "action": "cancel",
  "extras": { "rangeName": "${RANGE_NAME}" },
  "occurredAt": "${OCCURRED_AT}"
}
EOF
)"

# 5. Long trade hits take profit at the high
sleep "$STEP_DELAY"
send "trade_closed (long / take_profit / win)" "$(cat <<EOF
{
  "eventType": "trade_closed",
  "eventId": "trade_closed-${TRADE_ID_LONG}-leg-0",
  "tradeId": "${TRADE_ID_LONG}",
  "ticker": "${TICKER}",
  "side": "long",
  "quantity": ${QUANTITY},
  "action": "exit",
  "entryPrice": ${LONG_ENTRY},
  "exitPrice": ${LONG_EXIT},
  "closedAt": "${OCCURRED_AT}",
  "realizedTicks": ${REALIZED_TICKS},
  "realizedDollars": ${REALIZED_DOLLARS},
  "outcome": "win",
  "extras": { "rangeName": "${RANGE_NAME}", "exitReason": "take_profit" }
}
EOF
)"

echo "Simulation complete. Check the Journal / Alerts page to see the lifecycle."
