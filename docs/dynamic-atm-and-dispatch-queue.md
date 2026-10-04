# Dynamic ATM Templates & High-Fanout Dispatch — Design Notes

Status: **design discussion** — not yet implemented.

## Goals

1. Per-bracket NT8 ATM templates carrying *that trade's* strict TP/SL + break-even
   parameters (today: one static template per range, manually imported).
2. Support hundreds of accounts firing on a single alert with minimal added
   latency on the critical path.

## Current state

- `src/atm-template.ts` renders an NT8 ATM strategy XML per range
  (`AutoBreakEvenProfitTrigger`, `AutoBreakEvenPlus`, `StopLoss`, `Target`,
  fresh `AtmSelector` GUID per render).
- The wire already carries `atm_strategy` (currently = range name) and explicit
  SL/TP prices — the wire legs are the fallback protection regardless of ATM state.
- Templates live in `Documents\NinjaTrader 8\templates\AtmStrategy\*.xml` on the
  VPS that runs NT8 + the CrossTrade plugin.

## Part 1 — Dynamic template lifecycle

### Naming

- Template name = `BR-<bracketId>` when levels are per-trade.
- Alternative: `LV-<hash of SL/TP/BE params>` — one file shared by every bracket
  on the same NT8 instance with identical levels. Strongly preferred at scale:
  hundreds of accounts on one NT8 firing the same signal want ONE file write,
  not hundreds, and deletion becomes a refcount ("no open bracket references
  this hash") instead of a lifecycle event.

### Lifecycle

1. `entry_armed` → render XML → `PUT` file to VPS agent → dispatch entry
   (parallel — see latency section).
2. `trade_closed` / monitor retirement → decrement refcount → `DELETE` file
   when the last referencing bracket closes.
3. Boot reconciliation → agent diffs its directory against the bridge's
   expected set; deletes stale `LV-*`/`BR-*` files.

### Latency model — the file is needed at FILL time, not dispatch time

Entries go out as Working orders; NT8 instantiates `atm_strategy` only when the
entry fills. So the template write can be **fire-and-forget in parallel with
dispatch** — zero added latency on the order path. A ~200ms file write races
against fills that normally take minutes.

Failure mode if a fill lands before the file: entry fills without ATM legs, but
the wire's explicit SL/TP legs still protect the trade (no BE move). The CT
sweep can additionally flag `filled + no template write confirmed`.

### Transport (recommended)

- **Agent**: ~80-line HTTP service on the VPS, bound to localhost:
  - `PUT /atm/<name>` → write `<name>.xml` to `templates\AtmStrategy\`
  - `DELETE /atm/<name>` → remove it
  - `GET /atm` → list files (reconciliation + sweep verification)
  - Bearer-token auth on all routes.
- **Exposure**: Cloudflare Tunnel (`cloudflared`) → `https://agent.<domain>`,
  valid TLS, **zero inbound firewall ports**. Avoid raw open ports — Render
  egress IPs aren't stable enough for allowlisting, and HTTP+secret is sniffable.
- Alternative considered (rejected): pull-based file watcher polling the bridge.
  Works, but adds poll-interval latency before the template exists — push is
  strictly better here since the write is off the critical path anyway.

### Open risks to verify on the VPS

- NT8 hot-loads new files dropped into `templates\AtmStrategy\` without restart.
- `AtmSelector` uniqueness across instantiations (already randomized).
- Behavior when `atm_strategy` names a template that doesn't exist at fill:
  confirm NT8 fails the leg spawn loudly vs. silently.

## Part 2 — Dispatch fan-out at hundreds of accounts

### The problem

A single `/proxy` alert fans out to every routed account: N outbound webhook
POSTs (plus now N or fewer ATM writes, deduped by NT8 instance). Deliveries
today happen inline-ish per delivery row; at ~100ms+ per broker round trip,
hundreds of sequential sends = tens of seconds of tail latency.

### Proposal: dispatch queue + worker pool

Introduce a persistent delivery queue (or in-process job runner to start):

- Enqueue one job per (delivery, account) — a row exists in `broker_orders`
  already; the queue is just the *execution* engine over it.
- **Worker pool sized by concurrency target** (e.g. 16–32 parallel sends);
  each send already records `pending → acknowledged/uncertain/rejected` and
  retries through existing machinery.
- **Per-destination sequencing**: jobs for the same NT8/CT instance must
  serialize with respect to ORDERING (entry before its exits, cancels before
  re-arms, OCO pairs together) — parallelism is across *destinations*, not
  within one.
- **Priority lanes**: `exit`/`cancel`/flatten jobs preempt `entry` jobs —
  flattening risk beats placing new risk.
- **ATM template write = a queue step**: `template:put` job per NT8 instance
  precedes that instance's entry jobs; `template:delete` on refcount zero.
  Dedup by file name so 200 accounts on one NT8 = 1 PUT + N order sends.
- **Backpressure**: per-destination rate limiter (CT has a rate budget —
  the sweep already pays attention to this), plus failure backoff mirroring
  `ctSweepAccountCooldown`.

### One service per user? No.

- Rate limits, ordering, and template files are properties of the **NT8/CT
  instance** (a machine + plugin), not the user. Worker granularity should be
  *per destination endpoint*, regardless of which users route through it.
- Per-user services multiply connections, memory, and failure modes for no
  ordering benefit — a user's accounts may also span multiple NT8 instances
  anyway, which a per-user model can't express cleanly.
- Keep it one dispatcher process with a `Map<destinationKey, lane>` structure.
  If CPU/process isolation ever becomes necessary, split by *destination
  partition* (e.g. worker 1 handles NT8 instances A–M), not by user.

### Deployment reality: one NT8/VPS per user

Each user runs their own NT8 instance on their own VPS, hosting their ~20
accounts behind one CrossTrade endpoint. That reframes the whole problem:

- **A destination lane = one user's NT8/CT endpoint**, shared by all their
  accounts. Sends to one NT8 serialize at the CT plugin anyway (single NT8 UI
  thread) — per-destination concurrency of a few parallel sends is all that's
  useful, more just queues at the plugin.
- **All parallelism lives across users.** Dozens of users = dozens of
  independent lanes. A 10-user × 20-account fanout is 200 sends but only ~20
  sequential sends per lane — at ~100–300ms each, every account is dispatched
  in ~2–6s total, no matter how many users fire simultaneously.
- **The bridge is almost never the bottleneck.** Node does thousands of
  concurrent outbound HTTP sends without breaking a sweat; the slowest link is
  each NT8 plugin's own processing rate. A bigger Render box buys headroom for
  web serving + sweep + dispatch concurrency, not raw dispatch speed.

### What "robust" means concretely

1. **Durable job queue.** Deliveries become rows (a `dispatch_jobs` table, or
   reuse `broker_orders` with a `queued` state) at ingest time. The webhook
   acks 202 after *persisting*, not after *sending* — a crash mid-fanout
   resumes from rows, never from memory.
2. **Worker pool + lanes.** N workers claim jobs; `Map<destinationKey, lane>`
   enforces per-NT8 concurrency (~4) and ordering within (account, instrument):
   entry → fills/cancels → exit, cancels before re-arms, OCO pairs atomic-ish.
3. **Priority.** exit/flatten/cancel classes jump the lane — closing risk
   always outranks opening risk.
4. **Idempotent, resumable sends.** Every job ties to a `broker_orders` row;
   crash-before-response = `uncertain` (already modeled), the sweep reconciles.
   Retries with backoff + per-destination circuit breaker (reuse
   `ctSweepAccountCooldown` semantics — a down VPS shouldn't stall its lane).
5. **Slow-lane isolation.** One unreachable NT8 must never block others —
   lanes are independent and cooldown-bounded by construction.
6. **Observability.** Queue depth, per-destination p99 send latency, dead-
   letter count. Alerts fire from the queue, not from user complaints.

### When do you outgrow a single dispatcher?

Only when *outbound HTTP volume itself* saturates — thousands of simultaneous
dispatches across many users at once, or heavy TLS/serialization CPU. The
design already allows it: jobs are DB rows, so a second dispatcher process
claims partitions via `SELECT … LIMIT` + lease/`claimed_by` (shard by
`destinationKey` hash). That's a deployment change, not a rewrite — don't
build it until queue-depth metrics say so.

### Process topology — start in-process, extract only if needed

Phase 1: an in-process async dispatcher (queue table or in-memory lanes +
worker pool) inside the existing server. The whole critical path for a fanout
becomes: enqueue N jobs → workers drain with per-destination ordering → ledger
rows stream updates via existing SSE invalidation.

Phase 2 (only if measurement demands it): extract the dispatcher into a
separate process reading the same SQLite queue — isolates dispatch from web
serving, restarts independently. Defer until a real bottleneck shows; SQLite +
a lane map goes surprisingly far.

### Latency accounting for a 200-account fanout

- Entry send per destination ~100–300ms; with 16 workers across e.g. 20 NT8
  instances → all entries out in ~1–2s, plus the single template PUT per
  instance in parallel.
- The ordering that matters (entries before exits per bracket) is preserved by
  per-destination lanes; nothing waits on the ATM write except that instance's
  entry job — and even that wait is optional given the fill-time semantics.

## Open questions

- How many distinct NT8/VPS instances vs. accounts? (Determines whether
  destination lanes ≈ accounts or a much smaller set.)
- Are per-bracket levels actually different per signal, or per-range? If
  per-range, `LV-<range>` templates already exist — the dynamic part shrinks
  to just installation/delete-on-flag-flip.
- Should `atm_strategy` keep encoding the range (needed for `ownerStrategy`
  attribution in the sweep)? A `LV-*` name breaks the current
  `ownerStrategy == rangeName` matching — either encode the range in the
  template name or extend the match rules.
