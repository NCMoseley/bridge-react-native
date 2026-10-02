#!/usr/bin/env python3
"""Simulate an EOD flatten: post exit_filled + trade_closed (breakeven)
lifecycle events for every position the local DB still considers open.

Usage:
  ./scripts/reconcile-open-positions.py [account_id]

Env: BASE_URL, PROXY_SECRET, RANGE_NAME, SOURCE, SLEEP_SECONDS, DB_PATH,
     INCLUDE_CRYPTO=1 (default skips crypto roots)
"""

import json
import os
import sqlite3
import sys
import time
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH", os.path.join(HERE, "..", "data", "bridge.sqlite"))
RANGE_NAME = os.environ.get("RANGE_NAME", "Test Range")
BASE_URL = os.environ.get(
    "BASE_URL", "https://5c18-2604-3d08-b174-a300-40cc-79b5-b6d2-7929.ngrok-free.app"
)
SOURCE = os.environ.get("SOURCE", "lifecycle-test")
SLEEP = float(os.environ.get("SLEEP_SECONDS", "1"))
INCLUDE_CRYPTO = os.environ.get("INCLUDE_CRYPTO") == "1"
CRYPTO_ROOTS = {"BTC", "MBT", "ETH", "MET", "SOL", "XRP"}

conn = sqlite3.connect(DB_PATH)
conn.text_factory = bytes  # keep raw bytes; ids may contain control chars

account_id = sys.argv[1] if len(sys.argv) > 1 else None
if not account_id:
    row = conn.execute(
        "SELECT account_id FROM range_routes WHERE range_name = ? LIMIT 1", (RANGE_NAME,)
    ).fetchone()
    if not row:
        sys.exit("error: no route/account found")
    account_id = row[0].decode()

proxy_secret = os.environ.get("PROXY_SECRET")
if not proxy_secret:
    with open(os.path.join(HERE, "..", ".env")) as fh:
        for line in fh:
            if line.startswith("PROXY_WEBHOOK_SECRET="):
                proxy_secret = line.split("=", 1)[1].strip().strip('"').strip("'")
                break
if not proxy_secret:
    sys.exit("error: PROXY_WEBHOOK_SECRET not found")
URL = f"{BASE_URL}/proxy/{proxy_secret}"

rows = conn.execute(
    """SELECT range_name, trade_id, instrument, side,
              SUM(CASE WHEN event_type='entry_filled' THEN quantity ELSE -quantity END) AS open_qty,
              MAX(CASE WHEN event_type='entry_filled' THEN entry_price END) AS entry_price
       FROM trade_events
       WHERE account_id = ?
         AND event_type IN ('entry_filled','exit_filled','trade_closed')
       GROUP BY range_name, trade_id, instrument, side
       HAVING open_qty > 0""",
    (account_id,),
).fetchall()

def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

def post(payload):
    req = urllib.request.Request(
        URL,
        data=json.dumps(payload).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.read().decode()[:300]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]

for range_name, trade_id, ticker, side, qty, entry_price in rows:
    trade_id = trade_id.decode("utf-8", "replace")
    ticker = ticker.decode()
    side = side.decode()
    range_name = (range_name or RANGE_NAME.encode()).decode()
    root = "".join(c for c in ticker if c.isalpha()) or ticker
    if root.upper() in CRYPTO_ROOTS and not INCLUDE_CRYPTO:
        print(f"-> skip crypto {ticker}")
        continue
    print(f"-> flatten {trade_id!r} ({side} {ticker} x{qty} @ {range_name}, entry {entry_price})")

    extras = {"source": SOURCE, "rangeName": range_name, "reason": "eod_flatten_reconcile"}
    exit_payload = {
        "eventType": "exit_filled",
        "eventId": trade_id + "-eod_exit_filled",
        "tradeId": trade_id,
        "ticker": ticker,
        "side": side,
        "action": "exit",
        "quantity": qty,
        "occurredAt": now_iso(),
        "extras": extras,
    }
    if entry_price is not None:
        exit_payload["exitPrice"] = entry_price
    status, body = post(exit_payload)
    print(f"   exit_filled HTTP {status} {body}")
    time.sleep(SLEEP)

    close_payload = {
        "eventType": "trade_closed",
        "eventId": trade_id + "-eod_trade_closed",
        "tradeId": trade_id,
        "ticker": ticker,
        "side": side,
        "action": "exit",
        "quantity": qty,
        "realizedTicks": 0,
        "realizedDollars": 0,
        "outcome": "breakeven",
        "closedAt": now_iso(),
        "extras": {**extras, "exitReason": "eod_flatten"},
    }
    if entry_price is not None:
        close_payload["entryPrice"] = entry_price
        close_payload["exitPrice"] = entry_price
    status, body = post(close_payload)
    print(f"   trade_closed HTTP {status} {body}")
    time.sleep(SLEEP)

print("done.")
