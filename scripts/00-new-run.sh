#!/usr/bin/env bash
# Start a fresh test run: clears the shared run id so the next arm generates
# new bracket/trade ids. Run this before each new test round.
#
# Usage:
#   ./scripts/00-new-run.sh
set -euo pipefail

RUN_FILE="/tmp/pine-test-run"
rm -f "$RUN_FILE"
echo "Cleared $RUN_FILE — next script run starts a new test round."
