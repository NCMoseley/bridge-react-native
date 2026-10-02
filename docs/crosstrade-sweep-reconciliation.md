# CrossTrade Sweep & Reconciliation Design

Working reference for how the bridge reconciles CrossTrade (NT8) broker state
against local bookkeeping — what the sweep proves, what it writes, and *why*.
Update this document when a rule changes. Companion to
`lifecycle-decisions.md`, which owns the Ultra → Bridge → broker lifecycle rules.

## The three stores

| Store | Meaning | Authoritative for |
|---|---|---|
| `bracket_monitor` | What Pine/Ultra *simulated* (`armed`/`filled`/`closed`/`cancelled`) | Open Orders, EOD, reconcile, reapply guards |
| `trade_events` / `range_trade_events` | Lifecycle journal (Pine alerts + synthetic closes) | Journal, performance |
| `broker_orders` | What was actually *sent* to the broker and its outcome | Dispatch state, broker evidence |

A missing Pine `trade_closed` leaves the monitor `filled` — a phantom position.
The sweep is the designed backstop.

## Governing principle: decide on legs, not the book

**Reconciliation decisions are made from individual order legs, never the
netted position.** The CrossTrade orders read returns per-order state for
every leg — our entry, the ATM-owned Stop1/Target1 exits, resends — each
correlatable to a bracket via `matchesCtOrderId` (order_id echo — NT8 wraps
it in a `userData` XML blob as `<AutomatedTradingOrderId>id</...>`, which
must be extracted before comparing — `oco_id` stem + action, `-a<n>` resend
forms) or `ownerStrategy === rangeName`.

The positions read is instrument-netted: it cannot distinguish the bracket's
exposure from a manual or other-strategy position on the same root. Using it
as the primary signal produces the classic blind spot — a user holding a
same-side manual position keeps the book "long" forever and the bracket
never reconciles. Positions data is retained only as a *secondary* signal:
corroborating evidence when order history has been pruned, and the
reversal-detection case (opposite-side position proves exit even when exit
legs are gone).

Per-leg close rules:

- **A strategy-owned exit leg `Filled` covering the bracket's qty → the
  bracket closed.** Filled in NT8 is complete; PartFilled falls under the
  working-order gate instead. This fires regardless of what the netted
  position says.
- **A correlated leg still Working/PartFilled → defer.** Live legs mean the
  bracket's exposure or attribution is unsettled.
- **No correlated live legs + position flat/reversed + broker-confirmed
  entry → close** (book-forgotten fallback; see below).

Leg→bracket correlation is only safe on an unambiguous root
(`filledCountByRoot[root] === 1`): Stop1/Target1 legs carry `ownerStrategy`
(the range) but not the bracket id, so two filled brackets on one
range+instrument cannot be told apart per-leg. Ambiguous roots fall back to
the flat-book + consensus rules.

## When the sweep runs

`sweepUncertainCrossTradeOrders` (`src/server.ts`):

- Every `CT_SWEEP_INTERVAL_MS` (default 60s), **only when
  `NODE_ENV=production`**. Dev/test instances do not sweep periodically —
  they would burn the shared CrossTrade rate budget on throwaway state.
- `CT_SWEEP_ENABLED=1|0` overrides either direction.
- Manual pass: `POST /app/debugging/ct-sweep-now` (dev-only button on the
  Journal Open Orders header). Forced sweeps ignore the failure cooldown.
- NT8 read failures back off per account, exponential up to 5 min
  (`ctSweepAccountCooldown`). **A failed read is *unknown*, never evidence** —
  it never implies flat, rejected, or closed.

## What the sweep reads

Per-account per pass (one call each, reused across both sweep halves):

- `GET /accounts/:account/orders` — every order row NT8 still holds:
  `orderState`, `orderAction`, `quantity`, `filled`, `averageFillPrice`,
  `time`, `ocoId`, `ownerStrategy`, `userData`, `automatedTradingOrderId`.
- `GET /accounts/:account/positions` — net position per instrument
  (secondary signal only).
- `GET /accounts/:account/orders/:orderId` — single-order fallback when a
  probed order isn't found in the book (NT8 regenerates
  `AutomatedTradingOrderId` on plain entries, so direct lookup can 404 a
  live order; the `oco_id`+action book match is the reliable path).

## What a sweep pass does

Two halves, one orders-book read per account:

### 1. Order probes

`broker_orders` rows stuck `pending`/`uncertain` past the 2-min grace
(`CT_PROBE_GRACE_MS`), plus `acknowledged` rows inside the 30-min verify
window (`CT_VERIFY_WINDOW_MS`), are resolved against the NT8 book. An ACK is
not proof NT8 accepted the order — asynchronous rejects only show up in the
REST read.

Outcomes (`applyCtProbeOutcome`):

- `filled` → `syncCtFillToJournal` writes `entry_filled` if Pine never
  reported one (id `ct-verified-<bracket>-entry_filled`), or upgrades the
  journaled entry price/qty from `averageFillPrice`.
- `rejected`/`cancelled` → `retireUncoveredArmedMonitorRows` retires the
  `armed` monitor as `entry_cancelled` — but only when no *other* open
  dispatch still covers the arm (a live resend keeps it armed). This fixes
  Open Orders; it does not write a journal `entry_cancelled` event.
- Verified rows leave the probe set (`ct-verified` status source) — probed
  once, never re-probed every tick.

**Whole-book leg sync.** While the account's orders read is held, every open
CT entry row (buy/sell, any age — not just the probe work list) is re-matched
against the book and mirrors its leg's state via the same resolver. This
converges rows the probe set would never revisit: an `acknowledged` order
asynchronously rejected after the verify window, a `pending` row that landed
before the grace elapsed. Only rows *present* in the book participate —
absence is the grace-gated probe's decision, and the per-order HTTP fallback
stays out of the free pass. Account-level position is irrelevant to this
sync: each leg updates to its own state.

**Absence removal** (`CT_ABSENT_REMOVE_MS`, default 5 min, env-overridable;
floor is the probe grace). NT8 retains live and terminal orders in the book,
so a leg still missing past this window is dead — the row resolves
`rejected` even when it had `acknowledged`, and the uncovered-arm pass
retires any `armed` monitor it covered. Absent rows past the window get one
single-order lookup to confirm the miss before removal; younger absent rows
stay `in_flight` on the grace-gated probe path.

**Leg adoption.** The inverse scan — a *live* NT8 leg (Working/PartFilled)
whose wire id matches a bracket the monitor or ledger knows was sent by us,
but covered by no open ledger row — is an order we dispatched whose
bookkeeping was lost. The terminal ledger row for the wire id is **revived**
rather than duplicated — to `acknowledged` for a Working leg, to `filled`
for a PartFilled one (a partially filled entry is a position, not a working
order; `syncCtFillToJournal` writes the broker-observed `entry_filled` so
the monitor lands `filled`, not `armed`). For the Working case a `cancelled`
monitor arm is re-armed via `reactivateBracketMonitorArm`.
Only entry-action legs adopt (an exit-side leg on the same stem is not
re-minted as an entry row); `closed` monitors are never revived — a working
entry leg after a completed trade is an orphan, not the trade reopening.
Untagged rows — manual orders — are ignored. Logged as
`crossTradeAdoptedOrder` with `monitorRevived` in the payload.

Adoption runs for **every swept account** — `sweepAccounts` includes
`listAccountsWithCrossTradeOrders()` (all accounts that ever dispatched to
CT or hold monitor rows), not just probe-eligible ones, because a leg whose
bookkeeping is gone appears in no activity-scoped list.

### 2. Close synthesis (`syncFilledBracketClosures`)

For `filled` monitor rows **backed by a real dispatch**
(`hasAttemptedEntryOrder` — a Pine-only fill is simulated state, never
reconciled), the close is proven per-leg:

**Primary trigger — filled exit leg.** A strategy-owned opposite-action leg
(`ownerStrategy` = range, not our own order id, filled after entry) in state
`Filled` with qty covering the bracket → close with real `averageFillPrice`
→ real ticks/dollars/outcome. Requires an unambiguous root; fires even while
the netted position reads same-side (manual position case).

**Fallback trigger — flat book.** No same-side position on the root, no
correlated leg live, and broker-confirmed entry evidence (Filled entry row
on the book, or a prior confirmed ledger row — NT8 prunes history, so
ledger confirmation is sufficient). Exit attribution then comes from
strategy-owned Filled legs as above; unmatched closes journal breakeven $0
with `exclusionReason: 'erroneous'` ("exit fill not matched" — a real
breakeven is not fabricated).

**Ambiguous roots** (multiple filled brackets on one instrument): close on
the flat book, attribution only via consensus — all candidate exit fills
agree on one price *and* cover the total filled qty.

**What it writes:** `trade_closed` in `trade_events` + `range_trade_events`
with id `ct-flat-<tradeId>-<side>-trade_closed`;
`retireBracketMonitorEntry` → `closed`; entry broker order → `closed`
(`status_source: 'bridge'`).

**Recently-closed rows** (same journal day, UTC-4) get a second pass:
matched broker fills **replace** a Pine-journaled realization — broker data
is authoritative over Pine's strategy-side estimates in both directions.

## If the real Pine alert arrives late

Close dedupe is at the *trade* level (`findTradeClosedForTrade`), not the
event id:

- Prior `ct-flat-` row with `exitPrice == null` (unmatched) → Pine's real
  numbers upgrade it in place via `updateTradeEventRealization`.
- Prior `ct-flat-` row with a matched exit → Pine's report is skipped;
  broker numbers stay.
- Prior real Pine close → a later sweep synth is a no-op; a *matched* broker
  read can still upgrade the realization.

## The working-order gate (scoped 2026-09-30)

Defer only while a leg **provably bound to the bracket** is live
(Working or PartFilled):

- `matchesCtOrderId` on entry or exit action — order_id echo via
  `userData`/`automatedTradingOrderId`/`name`, `oco_id` stem + action, and
  `-a<n>` resend forms all match.
- `ownerStrategy.name|displayName === rangeName` — ATM-owned Stop1/Target1
  legs.

Replaced the old TradersPost-derived rule (any working order on the
instrument deferred — correct for Tradovate's instrument-scoped cancel,
wrong for CT where orders are individually identified). Unrelated manual
working orders no longer block closes. For multi-bracket instruments the
gate is per-bracket — a sibling's working leg blocks only rows it
correlates with.

Still protected: an OCO sibling that hasn't died after a flatten, a
partially-filled entry remainder, a resend leg that could reopen exposure.

## Manual broker-side fills: detection vs attribution

A discretionary fill carries no bracket identity — `orderAction`,
`orderState: Filled`, `ownerStrategy: null`. Nothing says "this closed
bracket X" versus "user scalped the same instrument mid-trade". Under
decide-on-legs:

- Manual **working** orders: ignored entirely — not correlated, don't defer.
- Manual **fills**: ignored as orders; their *effect* (flat book / filled
  exit leg elsewhere) is detected, but they are never attributed — the
  close journals unmatched-breakeven, excluded from performance. A manual
  same-side **position** no longer blocks the close under the leg-first
  rule (the filled exit leg is sufficient proof).

### Open item: ownerless exit attribution

When `filledCountByRoot[root] === 1`, an ownerless opposite-side fill after
the entry is arguably the exit. Candidate: accept it, aggregate fills until
`row.quantity` is covered, VWAP the price, note `manual exit attributed` in
`adjustmentNote`. Wrong-case: user partially trades the same instrument
during an open bracket — bounded by the close requirement but nonzero, and
it would fold discretionary fills into strategy performance.

## Failure semantics

- Unknown is never evidence: failed reads, missing rows, ambiguous
  attribution all defer or record-breakeven rather than guess.
- Everything synthesized is upgradeable: ct-flat ids are recognizable
  (`ct-flat-` prefix) and late Pine alerts / later matched reads repair the
  journal in place.
- Operator visibility: deferrals and ambiguities emit `crossTrade*` bridge
  logs + persistent toasts; probes emit `crossTradeSweepProbe` per order.
