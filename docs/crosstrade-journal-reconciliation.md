# CrossTrade Journal Reconciliation — Broker-Verified Bookkeeping

## Problem (observed 2026-10-01/02)

Comparing a CrossTrade journal export (`crosstrade-journal-trades-all-accounts-*.csv`) against
`trade_events` shows the bridge booking roughly 2x broker P&L. Root cause: `trade_closed`
realization values (`entry_price`, `exit_price`, ticks, dollars) are written verbatim from
the Pine alert payload (`src/webhook.ts` → `database.recordTradeEvent`), with no broker
verification. Ultra reports what its internal strategy model did — not what NT8 filled.

Concrete failures:

| Case | Journal | Broker |
| --- | --- | --- |
| RUPTURE SIL x3 | close 61.51→61.925, **+$1,245** | **no SIL trade on Oct 2** — phantom close |
| HEAVEN MGC short x2 | close 4179.3→4167.0, **+$246 × 8 accounts** | real exit ~4179.4 → **−$13** |
| TIGER MGC long x3 | close 4229.1→4230.6, +$45 × 11 | no MGC entry above 4223.3 in CSV |
| BREAKFAST MNQ short | entry_filled @ 30791.25 | broker filled 30787.75 — arm price, not fill |
| MGC longs @4223.3, Oct 2 ~02:04 ET | **zero bridge footprint** | real −$136 loss (manual/orphan trade) |

The existing sweep (`syncFilledBracketClosures`) already *upgrades* a journaled Pine close
to broker numbers when it can attribute a strategy-owned exit fill — but when no exit leg
is found it silently leaves Pine's numbers, and it never looks at positions/orders with no
monitor row.

## Recommendations

### 1. Phantom-close detection (Pine says closed, broker disagrees)

In the `recentlyClosed` pass, when the NT8 book **still shows a same-side open position** for
the closed bracket's instrument root, the journaled close is contradicted by live broker
state:

- mark the `trade_closed` row `excluded_from_performance` with reason `erroneous`
  (it is not a real fill — Pine's prices are strategy-side estimates),
- log `crossTradePhantomClose` and emit a persistent warning toast,
- leave the monitor row `closed` (Pine lifecycle is authoritative for bracket state) — the
  row is flagged for review rather than reopened silently.

When the book is flat but no strategy-owned exit fill can be attributed, state is *unknown*
— leave Pine's numbers in place (NT8 prunes order history; absence is not evidence), but do
NOT let it silently persist either — this is covered by #3 attribution only when legs exist.

### 2. Orphan broker position/fill surfacing

When the sweep reads a live NT8 position (or a filled order) on an instrument with **no open
`bracket_monitor` row and no CT ledger dispatch**, it is broker-side activity the bridge never
saw — manual orders, rearmed NT8 strategies, or missed alerts:

- log `crossTradeOrphanPosition` / `crossTradeOrphanFill` to `bridge_logs`
- emit a persistent toast (once per account+root per sweep run — the existing
  `ctDeferredWarned` style dedupe set)
- do not synthesize journal rows: P&L is unknowable without matching entry/exit legs;
  detection + operator visibility is the safe floor.

### 2b. Missing ATM protection detection

`checkAtmTemplateDivergence` previously only compared legs **when they existed** — a filled
entry with zero strategy-owned exit legs silently passed (and non-BE ranges never checked at
all). Now: any filled entry with no strategy-owned Stop/Target legs on the book warns
`crossTradeAtmMissing` — an unprotected position can never produce an attributable exit
fill, so this is the earliest signal of the SIL-style phantom-close pattern.

### 2c. Stop-only entries (per-range setting)

Ultra picks `orderType: 'limit'` when the entry level is already inside the current price —
those fills chase a crossed level and book exits on reversals. `range_configurations.
stop_only_entries` (**default ON** — every range; the UI exposes it inverted as "Crossed-level
entries: Blocked/Allowed" on the range card) makes the dispatch path refuse any non-stop
entry (`market`/`limit`) **at the wire**: the order never reaches CT, the ledger row is
`rejected`/`bridge` with the reason, and the arm stays locally armed until Pine's cancel
retires it. Per-range opt-out for A/B forward testing. Event: `crossTradeStopOnlyBlocked`.

### 2d. Auto-retry of rejected entries + 10-min abort

The sweep re-dispatches armed brackets whose newest CT entry ledger row is `rejected`,
resending the *original* payload (same stop level) on a fresh `-a<n>` wire id per the resend
convention. Bounds: max 3 attempts, 10 minutes from the first dispatch — then the arm is
aborted (`entry_cancelled`, `crossTradeRetryAborted`). Bridge-side stop-only blocks are never
retried (deterministic, not transport failure). Ordering matters: retry runs **before** leg
sync — a rejected arm looks identical to an orphaned arm and would be retired first.
Events: `crossTradeEntryAutoRetry` / `crossTradeRetryAborted` / `crossTradeRetrySkipped`.

### 3. Exit-leg price correction already present — extend to qty

The `recentlyClosed` pass rewrites `exit_price`/realized values from matched NT8 exit legs.
Keep this. Note it already protects against the HEAVEN-style wrong-exit when the leg is
attributable; the gaps are only when the leg is missing (→ #1) or the bracket has no monitor
row (→ #2).

## Non-goals / constraints

- **TradersPost routing is untouched** — the changes live inside the CT sweep/verification
  path and the journal read side. One intentional exception on the CrossTrade dispatch side:
  stop-only mode blocks non-stop `place` commands at the wire (§2c). TradersPost deliveries
  are unaffected by all of it.
- Absent broker evidence is never proof of absence: failed book reads, pruned NT8 history,
  and ambiguous multi-bracket roots defer rather than flag (existing convention).
- Synthetic `ct-flat-*` rows keep their existing upgradeability semantics.
