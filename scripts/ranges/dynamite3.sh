#!/usr/bin/env bash
# DYNAMITE V3 range profile — used when RANGE_PROFILE=dynamite3.
# Overrides the defaults in scripts/pine-test-config.sh.

TICKER="MNQ1!"
RANGE_NAME="DYNAMITE V3"

# Bracket arm entry levels (breakout-style, matching ULTRA):
# - long arm:  buy stop at RANGE_HIGH, TP = RANGE_HIGH + TP_OFFSET, SL = RANGE_HIGH - STOP_OFFSET
# - short arm: sell stop at RANGE_LOW,  TP = RANGE_LOW - TP_OFFSET,  SL = RANGE_LOW + STOP_OFFSET
RANGE_HIGH=29800
RANGE_LOW=29590

TP_OFFSET=100
STOP_OFFSET=100

QUANTITY=1
