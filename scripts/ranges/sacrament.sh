#!/usr/bin/env bash
# THE SACRAMENT range profile — used when RANGE_PROFILE=sacrament.
# Overrides the defaults in scripts/pine-test-config.sh.

TICKER="MGC1!"
RANGE_NAME="THE SACRAMENT"

# Bracket arm entry levels (breakout-style, matching ULTRA):
# - long arm:  buy stop at RANGE_HIGH, TP = RANGE_HIGH + TP_OFFSET, SL = RANGE_HIGH - STOP_OFFSET
# - short arm: sell stop at RANGE_LOW,  TP = RANGE_LOW - TP_OFFSET,  SL = RANGE_LOW + STOP_OFFSET
# Placeholder gold levels — edit to the current MGC1! range before running.
RANGE_HIGH=4420
RANGE_LOW=4300

TP_OFFSET=88
STOP_OFFSET=88

QUANTITY=1

# MGC1!: 0.10-pt tick worth $1.00.
TICKS_PER_POINT=10
TICK_VALUE_CENTS=100
