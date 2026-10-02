#!/usr/bin/env bash
# Edit these variables before running the numbered Pine test scripts.

# Instrument to simulate.
TICKER="${TICKER:-MNQ1!}"

# Range that the alert will be routed to.
RANGE_NAME="${RANGE_NAME:-Test Range}"

# Bracket arm entry levels (breakout-style, matching ULTRA):
# - long arm:  buy stop at RANGE_HIGH, TP = RANGE_HIGH + TP_OFFSET, SL = RANGE_HIGH - STOP_OFFSET
# - short arm: sell stop at RANGE_LOW,  TP = RANGE_LOW - TP_OFFSET,  SL = RANGE_LOW + STOP_OFFSET
RANGE_HIGH="${RANGE_HIGH:-29860}"
RANGE_LOW="${RANGE_LOW:-29600}"

# Take-profit distance beyond the entry, per side.
TP_OFFSET="${TP_OFFSET:-100}"

# Stop-loss distance behind the entry, per side.
STOP_OFFSET="${STOP_OFFSET:-100}"

# Contracts to send.
QUANTITY="${QUANTITY:-1}"

# Instrument tick metadata: ticks per 1.0 price point and USD cents per tick.
# MNQ1!: 0.25-pt tick worth $0.50.
TICKS_PER_POINT="${TICKS_PER_POINT:-4}"
TICK_VALUE_CENTS="${TICK_VALUE_CENTS:-50}"

# Bridge base URL. Change this if you want to point at a tunnel again.
BASE_URL="${BASE_URL:-http://localhost:3000}"
