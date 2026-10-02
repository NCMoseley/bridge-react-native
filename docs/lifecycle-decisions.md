# Lifecycle & Dispatch Design Decisions

Working reference for what the bridge decides at each point in the
Ultra → Bridge → TradersPost lifecycle, and *why*. Update this document whenever
a rule changes — it is the contract for what "correct" means.

## Governing principles

1. **Ultra lifecycle alerts are commands, not suggestions.** A `trade_closed`
   always closes the bracket in `bracket_monitor` / Open Orders — inside a local
   transaction, before any network work — regardless of broker state.
2. **Reapply is redundancy, not a gate.** It exists to retry broker cleanup.
   A failed or stale reapply must never block the *next* reapply, the next
   entry, or lifecycle bookkeeping.
3. **We can control Bridge, not TradersPost.** Dispatch is best-effort. When an
   outcome is unknowable we record `uncertain` and keep moving — we never claim
   resolution we don't have, and we never let an unresolved dispatch hold local
   state hostage.
4. **We work with what we have** We might want to retry failed sends, 
   but the intention is not to block future trades for this account/instrument pair. 
   We use info from ultra to manage the bookkeeping / open trades. The usual scenario 
   is that the broker and ultra are correct. Bridge is just a messenger. 

## The two sources of truth

| Store | Meaning | Authoritative for |
|---|---|---|
| `bracket_monitor` | What Pine/Ultra *simulated* | Open Orders display, lifecycle state |
| `broker_orders` | What was actually *sent* to TradersPost and its outcome | Broker evidence, guards, reconciliation |

`broker_orders` separates observation from bookkeeping: `status` is the row's
effective state, `status_source` records who last wrote it (`dispatch`,
`lifecycle`, `bridge`, `operator`, `email`, `legacy`), and `dispatch_status`
preserves the last dispatch-observed outcome when a non-dispatch writer later
overwrites `status`. A Pine `entry_filled` may mark an order `filled` while
`dispatch_status` still records that the send only ever reached `uncertain`.

A Pine `entry_filled` is simulated. A `filled` monitor row only counts as
broker evidence when `broker_orders` shows a **non-rejected entry dispatch was
attempted** for that bracket (`hasAttemptedEntryOrder`). The check reads
`dispatch_status` first and falls back to `status` — a rejected send whose
effective status was later flipped by a lifecycle or operator write still
proves no order exists at the broker.

## Entry alert decision points

```
entry alert
  │
  ├─ route/destination disabled?        → routing_disabled (no send)
  ├─ entry already delivered?           → suppressed_duplicate
  ├─ unfinished reapply op?             → no problem, the next reapply will correct everything at the broker
  └─ otherwise                          → forwardToTradersPost
        │
        ├─ 20 s hard timeout            → order: uncertain
        ├─ queue watchdog (60 s) abort  → task bails via taskSignal
        ├─ 2xx + explicit success:true  → acknowledged
        ├─ success:false / definite 4xx → rejected. if email notification
        │                                 arrives about rejection, retry
        └─ anything else (2xx without
            success:true, 5xx, timeout) → uncertain
```

- An **uncertain** entry keeps the ledger honest: the order may exist at the
  broker. It still counts as "attempted" for the filled-guard.
- A **rejected** entry proves no broker order exists.
- **No row at all** (wedged queue, disabled route) means the send never ran —
  phantom state, must not influence guards.
- **Operator resends are never blocked** by an unresolved prior attempt; the
  operator accepts the duplicate risk. Resends allocate `-r<n>` order ids so
  the interrupted attempt's row is never overwritten.

## Lifecycle event decision points

| Event | Monitor effect | Dispatch effect |
|---|---|---|
| `entry_armed` | armed | none (entry already dispatched) |
| `entry_filled` | armed→filled; a cancelled row may still accept it | none — bookkeeping only |
| `entry_cancelled` | armed→cancelled; **ignored on `filled`** (live position can't be cancelled) | none |
| `trade_closed` | →closed, **always, in-transaction** | enqueues per-route reapply op |

Monitor transitions are protected: `closed` ignores everything; `filled`
ignores `entry_armed`/`entry_cancelled`. The journal still records all alerts
faithfully — only the state machine is protected.

Lifecycle events also transition the bracket's `broker_orders` entry row
(`status_source='lifecycle'`, `NULL`-side rows match too): `entry_filled` →
`filled`, `entry_cancelled` → `cancelled`, `trade_closed`/`exit_filled` →
`closed`. Only the newest matching open attempt moves, so a repeat event never
silently resolves a still-uncertain earlier resend.

Schedule/route gating applies to *admission*, not resolution. `entry_armed`
on an unscheduled day or a disabled route is refused (no journal trade, no
monitor row). But once a monitor row exists, later `entry_filled` /
`entry_cancelled` / `trade_closed` resolve it regardless of schedule or
route state — `listLifecycleBracketAccounts` makes the accounts holding that
bracket (or its reapply replacement) recipients. A close still runs reapply
cleanup on unscheduled days (`routeEnabled(route, cleanup)` bypasses only the
day check); a route with `traderspostEnabled` off resolves locally with no
broker traffic.

## Reapply (`trade_closed` cleanup) decision points

```
trade_closed recorded + op enqueued (atomic)
  │
  ├─ destination/route disabled, or plan stale    → skip op (log why)
  ├─ FILLED GUARD: another bracket filled on this
  │   account+destination-instrument AND its entry
  │   was actually attempted (non-rejected row)    → skip entire op
  │   · phantom fill (no broker_orders row)        → does NOT block
  │   · rejected entry                             → does NOT block
  │   · uncertain attempted entry                  → DOES block
  │
  └─ plan: cancel → exit → re-arms (nearest close first)
        │
        ├─ step sends                            → 20 s timeout each
        ├─ taskSignal aborted (batch watchdog)   → pause, "reconcile and retry"
        ├─ definite HTTP rejection               → resumable on retry
        ├─ uncertain outcome (timeout, 5xx, lost response)
        │                                        → continue with cancel → exit, but pause 
        │                                        reapply — blind replay could
        │                                        duplicate orders
        ├─ stale stop level (through the market) → step 'skipped', no dispatch
        └─ all steps delivered                   → op complete
```

**Supersede rule:** a new close on the same
account+instrument never waits on a stale op — the old op is superseded
(ledger preserved, retry becomes no-op) and a fresh op plans against the
current armed pool. The next close *is* the retry: its cancel+exit re-attempts
the flatten.

- Planning is transactional: the plan (supersede marks, carried-arm merge,
  step list) is computed and saved in one SQLite transaction, and the arm pool
  is deduped on logical trade id so a carried arm and a freshly armed row for
  the same trade can't double-re-arm.
- Recovery on startup runs in the background (the listener does not wait on
  it — boot/listening is never wedged by recovery), sweeps orphaned
  `pending_*` rows to honest terminal states, and refuses to blind-replay
  uncertain steps. Recovery shares `reapply.queue` with live dispatches: it
  does not block other accounts, but same-account work can queue behind one
  watchdog-bounded recovery operation — FIFO ordering is required, since an
  entry jumping ahead of a recovery op's instrument-wide cancel would be
  cancelled by that sweep.
- External instrument-wide cancels (flatten, EOD, reconcile) **invalidate** an
  unfinished plan rather than letting it re-arm over them.

## Failure-email decision points

An emailed rejection (e.g. `InvalidPrice`) attributed to an armed monitor:

- Entry-side rejection with **no sibling/open dispatch covering the arm** →
  retire the monitor row.
- TP/exit-leg rejection on a working entry → do **not** retire the entry.
- Ambiguous attribution → **no mutation**. Uncertainty is preserved, never
  resolved by guessing.

## What "halt" is allowed to mean

| Condition | Halts dispatch? | Halts bookkeeping? |
|---|---|---|
| Live filled bracket (attempted entry) | yes — that instrument's cleanup | no |
| Uncertain prior dispatch | no (blocks only blind *replay* of that step) | no |
| Failed/stale reapply op | no — superseded by next close | no |
| Wedged/hung request | no — 20 s timeout + watchdog release | no |
| TradersPost down | no — steps fail honestly, next close retries | no |

## CrossTrade broker-evidence resolution (CT only)

Unlike TradersPost, CrossTrade exposes a REST API over NT8 order state, so
`uncertain` CT dispatches are resolvable instead of permanently ambiguous.

- A probe keys on `bracket_id` (the wire `order_id`), never the ledger row id —
  entry dispatches are ledgered as `bridge-<delivery>` while NT8 tracks the
  bracket id in UserData.
- Tri-state: `Working` → `acknowledged`, `Filled` → `filled`,
  `Cancelled`/`Rejected` → terminal (+ armed-monitor retirement), confirmed
  not-found → `rejected` **only after a 2-minute dispatch grace window**
  (younger rows stay `in_flight`). Read failures, timeouts, and unrecognized
  NT8 states are `unknown` — never evidence of absence.
- Only entry actions are probed: cancel/exit are commands, not orders.
- Two drivers: a 60 s sweep over CT rows pending/uncertain past grace, and the
  admin `reconcile-crosstrade` endpoint (Debugging card button) for on-demand
  resolution. Both write `status_source='bridge'`; Pine lifecycle stays
  authoritative and TradersPost semantics are unchanged.

## Known residual risks (accepted)

- An `uncertain` exit can leave a naked broker position: Bridge flags it
  (badge/toast/`uncertain` row) and the next cleanup pass re-attempts, but only
  a successful dispatch or operator action truly resolves it.
- Sequential fan-out means an early route's work runs before later routes —
  bounded by per-task timeouts, but a slow route still delays siblings.
- Pine-simulated fills for routes that were never dispatched are now ignored
  by the guard, but their monitor rows still show `filled` until a lifecycle
  or cleanup event retires them — display reality, not broker reality.
