# TODO — Dynamic ATMs & Dispatch Queue

Design context lives in `docs/dynamic-atm-and-dispatch-queue.md`. This file is
the actionable work list. Deployment reality: **one NT8/VPS per user**, ~20
accounts behind each user's CrossTrade endpoint; scale target is hundreds of
accounts across dozens of users firing on the same signal.

## Phase 1 — Durable dispatch queue (foundation for everything else)

DONE — built on the existing per-account queues instead of a new jobs table:
- [x] Fan-out is per-account-serial but cross-account-parallel
      (`Promise.all` over per-route queue tasks in `processProxyPayload`) —
      total latency = slowest lane, not the sum.
- [x] Lanes = `reapply.queue` / `traderspostRateLimiter` per account (250ms
      pacing, watchdog, abort semantics already in place).
- [x] Priority: `cancel` deliveries enqueue via `runNext` (head of lane).
- [x] Crash recovery: `listUnattemptedPendingDeliveries()` + boot resume
      re-enqueues zero-attempt pendings before the interrupted sweep; rows
      WITH attempts keep the conservative failed/uncertain outcome.
- [x] Metrics: `snapshot()` per lane (pending, running, tasksRun,
      avg/last task ms) exposed on `/app/api/monitoring` `dispatchQueues`
      (admin only).
- [x] Coverage: `src/dispatch-queue.test.ts` — parallel fan-out, cancel
      priority, resume, attempted-row non-resend.
- [x] Per-destination circuit breaker: ≥3 consecutive task failures back the
      lane off exponentially (2s → 60s cap) inside `TradersPostRateLimiter`;
      success clears instantly. Breaker state rides `snapshot()` into
      `dispatchQueues`. Lanes are per-account, so a dead VPS never stalls
      other destinations.
- [ ] `dispatch_jobs` table with claim/lease — only needed if a second
      dispatcher process ever ships (Phase 3).

## Phase 2 — Dynamic ATM templates

- [ ] VPS agent: ~80-line HTTP service bound to localhost:
      `PUT /atm/<name>` (write `<name>.xml` into
      `Documents\NinjaTrader 8\templates\AtmStrategy\`), `DELETE /atm/<name>`,
      `GET /atm` (list — reconciliation + sweep verification). Bearer auth.
- [ ] Exposure: Cloudflare Tunnel on the VPS → `https://agent.<domain>` —
      valid TLS, zero inbound firewall ports.
- [ ] Template naming: `LV-<hash of SL/TP/BE params>` (one file per unique
      level set per NT8 instance — hundreds of accounts share a write) rather
      than `BR-<bracketId>`. **Caveat:** `ownerStrategy` attribution in the CT
      sweep currently matches `rangeName` — encode the range in the name or
      extend `matchesCtOrderId`/ownerStrategy matching.
- [ ] Dispatch hook: on entry dispatch, enqueue `template:put` in parallel —
      fire-and-forget (template is needed at *fill* time, not dispatch time;
      wire SL/TP legs remain the fallback).
- [ ] Deletion: refcount per file; `template:delete` when the last referencing
      open bracket closes.
- [ ] Boot reconciliation: agent diffs its directory against expected set;
      deletes stale `LV-*` files.
- [ ] Verify on the VPS: NT8 hot-loads new template files without restart;
      behavior when `atm_strategy` names a missing template (loud vs silent).

## Phase 3 (only if metrics demand it)

- [ ] Multi-process dispatcher: jobs are DB rows → shard by `destinationKey`
      hash with lease/`claimed_by` claims. Deployment change, not a rewrite.

## Decisions made

- **Not** per-user services — lanes are per *destination endpoint*, the only
  real constraint. Per-user multiplies connections/failure modes for no gain.
- **Not** a pull-based file watcher — push via agent+Cloudflare Tunnel wins on
  latency and confirmation.
- NT8-side throughput: assumed solved (user's assessment).
