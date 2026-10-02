# Reconcile → Rebuild Design (next branch)

## Problem

When an order dies without a lifecycle close — transport failure, operator-cancelled
at Tradovate, InvalidPrice rejection — local bookkeeping cleans up but the
instrument's broker state stays divergent. Nothing rebuilds "wanted pending
entries" until the next `trade_closed` or EOD. Manual reconcile is the moment we
*know* divergence exists; today it only edits the ledger.

## Goal

After (or alongside) a manual reconcile, let the operator trigger a reapply-style
rebuild for the account/instrument: instrument-wide cancel → safeguard exit →
re-arm surviving armed brackets — while keeping full operator control over which
ranges/brackets participate.

## Decisions from review

### 1. Status gating — required, but reversible

- The rebuild may only be offered when the row is marked `rejected` or
  `cancelled`. Those marks mean "nothing exists at the broker."
- Never fire it off `acknowledged`/`filled`/`closed` marks — those assert the
  broker holds something, and an instrument-wide cancel right after would kill
  the order the operator just confirmed.
- The operator may legitimately change their mind later (mark rejected → verify →
  discover it actually landed). Reconcile must remain re-markable while a row is
  in a reconcilable state, and the rebuild decision must not depend on a
  one-time status flip being final. Treat the rebuild trigger as a separate,
  explicit action — not a side effect of the status write.

### 2. Separate action, not a side effect

- Keep `POST /app/debugging/reconcile-broker-order` bookkeeping-only: no broker
  traffic, as the confirm dialog already promises.
- Add a distinct control — e.g. "Rebuild instrument orders" — shown after a
  rejected/cancelled reconcile (and reachable from a dedicated card, see #4).
  It must clearly state that it sends real TradersPost traffic.

### 3. Operator controls exclusions — the bracket may not be dead

- Marking an order rejected is sometimes "the send never landed," sometimes "I
  changed my mind." Both are valid, and they differ in whether the bracket
  should come back.
- The rebuild UI should list the armed/open brackets on the account/instrument
  and let the operator uncheck any that must not re-arm. Default: the just-
  reconciled bracket is excluded only when its monitor row was actually retired
  by the reconcile; if the operator wants it back, they include it and it
  re-arms at its original entry price.
- Do NOT exclude the whole range by default — the reconciled bracket's opposite
  OCO arm may still be armed and should re-arm normally.

### 4. Prefer a dedicated card over per-row auto-trigger

Per-row auto-firing produces N instrument-wide sweeps for N reconciles (every
reconcile during a cleanup session). Better: a "Broker state / rebuild" card
(Debugging page, admin) that:

- lists instruments with submitted-but-unverified state per account
  (uncertain/pending/acknowledged broker orders, armed monitor rows with no
  covering dispatch);
- offers "Rebuild instrument" per account+instrument — one deliberate sweep
  covering all pending decisions, instead of one sweep per row;
- shows the exclusion checklist (#3) before sending.

This makes the batch problem disappear: cleanup session = reconcile rows freely,
then one rebuild click per instrument.

### 5. Stale prices — accepted risk

Re-arms replay original entry prices. Per review: unfilled levels are presumed
still favorable, so no extra validation beyond the existing stale-level skip
(buy stop at/below close, sell stop at/above close → `skipped`). Rejected
re-arms land in `broker_orders` like today's InvalidPrice rows — acceptable.

## Preconditions for the rebuild action

- Admin session, CSRF — same as reconcile.
- No `filled` `bracket_monitor` row on the account/destination-instrument
  (existing reapply guard — a live position blocks instrument cleanup).
- Account destination enabled, `reapplyOnTradeCloseEnabled`, route enabled for
  each participating range.
- Serialize through `reapply.queue` per account — same ordering guarantees as
  close-triggered reapply.
- Debounce: if a reapply op for the account/instrument ran in the last N minutes
  and nothing changed since, warn or require re-confirm.

## Suggested implementation shape

- `POST /app/debugging/rebuild-instrument` — `{ accountId, instrument,
  excludeBracketIds?: string[], csrfToken }`. Reuses the reapply planner
  (instrument cancel → safeguard exit → re-arm) with an explicit exclusion set
  instead of the closing-range carve-out.
- Reuse `retireUncoveredArmedMonitorRows` semantics for exclusion bookkeeping.
- Response mirrors the safeguard shape: per-instrument sent/error plus re-armed
  and skipped range lists.
- The reconcile UI adds a follow-up affordance linking to the card rather than
  firing the sweep inline.

## Observability

- Ledger every rebuild dispatch in `broker_orders` (`bridge-rebuild-*` order ids,
  `source` distinguishable from `reapply`).
- Bridge log entry listing excluded brackets/ranges for audit.

## Explicitly out of scope

- Automatic rebuild on reconcile (rejected — too easy to trip).
- Cross-account/global rebuild buttons.
- Changing what `rejected`/`cancelled` mean in the ledger.
