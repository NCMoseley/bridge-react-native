# E2E Test Criteria

Live end-to-end checks for the proxy → dispatch → broker → journal pipeline.
Run against the dev server (`localhost:3000`) using the seeded `E2E-*` accounts
(`scripts/dev-dual-mock-seed.ts`) and the built-in mocks (`/mock/traderspost`,
`/mock/crosstrade` — the CT mock serves the `/v1/api` REST twin and mirrors NT8
semantics: OCO sibling cancel on fill, `flatten`/`cancelorders` commands).
Do not run `ct-live-e2e.mjs` directly — it requires the generated `CT_E2E`/`PT_*` environment the wrapper creates and exits early otherwise.

## Baseline test — `ct-live-e2e.mjs`

**This is the standard E2E regression pass.** Run it before any prod deploy:

```
node scripts/e2e/ct-run.mjs      # ~45s, 23 assertions, isolated DB+port; runs ct-live-e2e.mjs
```

Phases: A) TP reapply cycle (cancel+exit+cross-range re-arm) · B) CT-matched
fill replacing a Pine-first close + broker averageFillPrice upgrading Pine's
fractional entry price on the journal/monitor · C) ct-flat synth + Pine-late
skip ·
D) terminal-bracket resend + monitor re-open + fresh `-aN` wire ids ·
E) ATM divergence ·
F) journal dual-flavor (Pine on TP vs broker on CT) · H) per-account sizing
overrides · G) concurrent open-trade board (rows left open for UI inspection).

Green = 23/23. Any FAIL line names the assertion; the detail column shows the
actual DB/wire state so the divergence is inspectable.

For real-broker passes, substitute the live CrossTrade destination and watch
NT8 directly. Assertions reference `bracket_monitor`, `broker_orders`,
`proxy_deliveries`, `trade_events`, `range_trade_events`, `bridge_logs`.

---

## 1. Dispatch

- [ ] Entry alert → `proxy_deliveries.status = traderspost_delivered` per
      enabled route; `broker_orders` row created `pending → acknowledged` after
      the 12s post-burst book verify (`status_source='ct-verified'`).
- [ ] CT wire message carries: `account`, `instrument`, `order_type` +
      `stop_price`/`limit_price`, `tif`, `order_id` = bracketId, `oco_id` (oco
      mode only), `atm_strategy` + `append_atm: 'true'` on BE-enabled ranges.
- [ ] Quantity override: `quantity_override_mode='percent'` multiplies alert qty;
      `'fixed'` replaces it; off → alert qty verbatim. Independent per account.
      Verified on BOTH routes: TP wire `quantity` AND CT wire `qty`; ledger
      `broker_orders.quantity` stores the OUTBOUND (post-transform) value.
- [ ] Re-apply micros: `micros_only` destination transform reflects in
      `broker_orders` quantity/instrument.

## 2. Order verification (post-burst + 60s sweep)

- [ ] NT8 `Working` → `acknowledged`; `Filled` → `filled` (+ synthetic
      `entry_filled`, monitor → filled); `Cancelled`/`Rejected` → terminal +
      arm retirement.
- [ ] Absence never downgrades `acknowledged`; absence only rejects
      never-confirmed (`pending`/`uncertain`) rows past the 120s grace and
      inside the 30min window.
- [ ] Failed reads (`ok=false`, 408, timeouts) are `unknown` — no state change.
- [ ] `acknowledged` rows are re-probed every sweep until terminal.
- [ ] Newest-row-per-wire rule: only the newest dispatch attempt for a bracket
      is resolved by the book verify.

## 3. OCO modes

- [ ] `oco`: both arms share `oco_id` stem (`<stem>-arm-<n>`); a fill at NT8
      cancels the sibling; local resolves `filled` + `cancelled`, sibling arm
      retired.
- [ ] `both`: no `oco_id` sent; after one side fills the sibling stays
      `Working` at NT8 and remains open locally.

## 4. Flat-position close synthesis (sweep)

- [ ] Filled monitor row + flat NT8 position + no working orders on the
      instrument → `trade_closed` synthesized (eventId `ct-flat-…`), monitor
      retires, success toast.
- [ ] Realized PnL from `ownerStrategy`-owned opposite-side fills
      (`averageFillPrice` vs entry fill); unmatched → breakeven with note.
- [ ] Manual orders on the same instrument (no `ownerStrategy`) do not
      trigger/attribute closes.
- [ ] Pine-only `filled` rows (no CT dispatch evidence) are never synthesized.
- [ ] Two filled brackets on one instrument → defer (no double attribution).
- [ ] Partial-fill (`PartFilled`) states block the close.
- [ ] Snapshot read happens inside the serialized account queue.

## 5. Journal precedence (Pine vs broker)

- [ ] `trade_closed` dedupes by tradeId, not eventId — one row per trade per
      account; one per range.
- [ ] ct-flat matched close (real exit price) is authoritative: later Pine
      `trade_closed` skipped.
- [ ] Pine-first + later matched CT fill → row's realization replaced in place
      (exit price, ticks, dollars, outcome) at both tables.
- [ ] Unmatched ct-flat (no exit fill) is upgraded by Pine's real numbers.
- [ ] TP-only accounts on the same range journal from Pine only.

## 6. Duplicate suppression (lifecycle-aware)

- [ ] Resend of an entry for a bracket that is still `armed`/`filled` →
      `suppressed_duplicate`, no wire call.
- [ ] Resend after the bracket went terminal (closed/cancelled) → dispatches
      (Ultra reuses range-epoch+seq ids for re-armed arms).
- [ ] Suppressed resends never mask the original `delivered` evidence — the
      Open Orders badge shows Armed ✓, not Blocked.
- [ ] `useLimitPriceTP` mode still requires fresh bracketIds (stricter).
- [ ] Resend + a *fresh* `entry_armed` eventId → monitor re-opens
      `closed→armed` (replays carry stale `occurredAt` and stay ignored).
      Re-arm with the SAME eventId dedupes — the monitor never sees it.

## 7. Toasts

- [ ] Cancel → green success; `rejected` → persistent warning; ack/fill →
      success; transport errors → failure.
- [ ] Toast colors are theme-proof (literal hex) and stack below the clock.
- [ ] ATM divergence → persistent warning once per account+range+bracket when
      live NT8 legs disagree with config SL/TP (>1 tick), including for entries
      that already filled.
- [ ] Orphan detection: ATM-owned Working order + flat position → warning
      (expect transient true-positives in the fill→OCO-cancel window).

## 8. Open Orders / monitor transitions

- [ ] `entry_armed` alert → row appears armed. CT verify fill → `filled`.
      Broker flat → closed.
- [ ] `closed` ignores all later events; `cancelled` accepts only fills;
      `filled` ignores arm/cancel.
- [ ] Accounts page: enabled-routes-without-destination warning; clone copies
      destination + secret + sizing + routes; column picker 1–4.

## 9. Failure paths

- [ ] `?mode=reject` → `rejected` row + persistent warning toast.
- [ ] `?mode=error&status=503` → `uncertain`, retried by the operator-resend
      path; no send count drift.
- [ ] `?mode=timeout` → `uncertain`; resolution via probe/operator, never
      auto-double-dispatch.
- [ ] Destination/route disabled while queued → `routing_disabled`.

## 10. Safety invariants

- [ ] Exit-all-safeguard flattens every submitted instrument: 0 working orders,
      0 positions, 0 open monitor rows after sweep.
- [ ] No dispatch is ever re-sent solely because a probe was inconclusive —
      resend requires operator action or lifecycle intent.
- [ ] `entries_per_range=2` + `both` mode: two live pairs coexist without
      cancelling each other.
- [ ] Cross-range same-instrument entries never share oco stems.

## Timing expectations

- Post-burst verify: ~12s after last send. Order sweep: every 60s.
- Probe grace: rows younger than 120s aren't probed — an entry can sit at
  `acknowledged`/`armed` for ~2–3 min after a broker fill; that's the designed
  send-safety window, not a stall.

## Isolated suite

`npm run test:e2e` (scripts/e2e/) covers the transport/lifecycle invariants on
a throwaway DB — see its own checklist in `scripts/e2e/driver.mjs`. This file
tracks the CT/live-broker layer on top.

## 11. Tradovate reapply cycle (trade_closed → reapply)

- [ ] `reapply_on_trade_close_enabled=1` destination + Pine `trade_closed` →
      reapply op plans and delivers **instrument-scoped** `cancel` + `exit`
      (payloads carry `ticker` + `extras.reapplyOnTradeClose`, NOT bracket ids).
- [ ] Cross-range re-arm: armed brackets on OTHER ranges sharing the
      instrument get an `entry` step — replayed at their ORIGINAL level with
      `extras.originalBracketId` + `bridge-reapply-*` ids. Same-range arms are
      cancelled, not re-placed.
- [ ] Stale re-arm: a replayed stop whose level is through the close price is
      planned `skipped` (never dispatched) — the arm stays cancelled.
- [ ] The op's steps persist delivered state in `reapply_operations.data_json`
      and each `entry` step's dispatch lands on the broker.

- [ ] Journal phase (F): TP route close shows Pine-reported values; CT route
      close shows broker-derived values; `range_trade_events` mirrors the CT
      close — both visible under the SIM-* ranges (flagged `test_data` —
      excluded from performance, not from the journal).

## 12. Broker-authoritative precedence (CT wins)

- [ ] Pine close first → CT-matched exit fill lands later → account AND range
      rows' realization replaced in place (ticks/dollars/outcome/exit_price).
- [ ] CT flat-close first (`ct-flat-*` eventId) → Pine close arrives later →
      Pine skipped, zero duplicate rows, CT numbers kept.
- [ ] Replacement requires the entry fill + a strategy-owned opposite exit fill
      (`ownerStrategy.name === range name`) postdating the entry — unmatched
      syntheses never overwrite real numbers.
- [ ] `crossTradeBrokerRealizationUpgrade` + `crossTradeFlatClose` land in
      `bridge_logs` (category `crosstrade`).

## 13. ATM divergence (warn-only, never blocks sends)

- [ ] Legs scoped to the entry's own `ownerStrategy` (range name) — other
      strategies' legs on the same instrument must not compare.
- [ ] The check runs in the position-sync sweep while the position is live
      (legs are Working) — not only in the post-burst verify.
- [ ] `crossTradeAtmMismatch` persists in `bridge_logs` once per
      account+range+bracket; dispatch is NEVER suppressed on a mismatch.
- [ ] Missing template is a separate concern: NT8 itself rejects the entry;
      the bridge only warns for live-leg divergence.

## 14. E2E harness notes

- [ ] `POST /app/debugging/ct-sweep-now` (admin session + CSRF body) forces
      one sweep — use instead of sleeping the 60s interval. Env knobs exist for
      `CT_SWEEP_INTERVAL_MS` / `CT_VERIFY_DELAY_MS` / `CT_PROBE_GRACE_MS`.
- [ ] Close synthesis needs broker-confirmed entry evidence: book Filled row
      OR prior broker-confirmed ledger (`dispatch_status` via ct-verified/
      probe). Present-but-unfilled entry row defers (`crossTradeCloseDeferred`);
      Pine-only fills never broker-close.
- [ ] Ambiguity: 2+ filled brackets share an instrument → rows still close as
      unmatched breakeven + `crossTradeAttributionAmbiguous` log — never a
      permanent defer (a stale filled row must not poison later closes).
- [ ] Phase G: concurrent board — multiple armed+filled rows across
      instruments AND accounts (all-route ranges create one monitor row per
      account); rows intentionally stay open for UI inspection.
- [ ] Harness hygiene: retire leftover monitor rows directly in DB at start;
      mock books reset on server reload — never save code mid-run.
- [ ] `hasFilled` reapply guard: a filled bracket on the instrument SKIPS
      planning entirely (`Skipped: another bracket is filled…`) — stale rows
      must be retired before expecting reapply steps.
- [ ] The CT mock's books are **in-memory** — a `tsx watch` reload (any code
      save) wipes positions/orders mid-test. Keep the server stable during a run.
- [ ] Monitor snapshots must be read inside `reapply.queue.run` — reads taken
      before serialization race the lifecycle pipeline.
- [ ] `ct-live-e2e.mjs` exercises phases A–E against the dev DB; mints an admin
      session into `sessions` for the sweep endpoint.
