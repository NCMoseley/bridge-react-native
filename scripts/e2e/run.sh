#!/usr/bin/env bash
# Isolated end-to-end pressure suite: fresh SQLite DB + controllable mock
# TradersPost + a real bridge server on a scratch port. Never touches
# data/bridge.sqlite or any real TradersPost destination.
#
#   npm run test:e2e
#
set -euo pipefail
cd "$(dirname "$0")/../.."
exec node scripts/e2e/run.mjs
