#!/usr/bin/env bash
# BUFFET 2.0 range profile — used when RANGE_PROFILE=buffet2.
# Overrides the defaults in scripts/pine-test-config.sh.

TICKER="MNQ1!"
RANGE_NAME="BUFFET 2.0"

# Bracket arm entry levels (breakout-style, matching ULTRA):
# - long arm:  buy stop at RANGE_HIGH, TP = RANGE_HIGH + TP_OFFSET, SL = RANGE_HIGH - STOP_OFFSET
# - short arm: sell stop at RANGE_LOW,  TP = RANGE_LOW - TP_OFFSET,  SL = RANGE_LOW + STOP_OFFSET
RANGE_HIGH=29890
RANGE_LOW=29540

TP_OFFSET=100
STOP_OFFSET=100

QUANTITY=1
