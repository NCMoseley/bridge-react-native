# Bridge v1.0.1

An invite-only relay for TradingView/ULTRA webhook signals, account-level TradersPost routing, and lifecycle journaling. Optional Chrome extension drafts require manual review/submission; enabled TradersPost routes send automated broker-facing requests. `AGENTS.md` is the current implementation reference, including the instrument-scoped reapply flow and its limitations.

## Versions

- **ULTRA**: 5.3 (TradingView Pine script emitting `entry_armed`, `entry_filled`, `trade_closed`, and `entry_cancelled` lifecycle alerts).
- **Chrome extension**: 1.0.0 (`extension/manifest.json`).

## Safety boundary

The extension can open/focus Tradovate and attempt to fill a selected draft's ticket values (side, quantity, entry, target, stop). It never changes the ticket's instrument — the draft panel displays the expected symbol and highlights it when the ticket differs, so the instrument must be selected manually. It never clicks Tradovate's final **Send** control. Always verify the symbol, side, order type, quantity, entry, target, and stop before submitting manually.

The extension's cancellation drafts are reminders only. Separately, enabled TradersPost routes and Bridge cleanup flows can send real instrument-scoped cancellation and exit requests. Bracket IDs do not target independent cancellations. ULTRA 5.1 leaves cancellation to the Bridge; reapply cancels the instrument and rebuilds the wanted pending entries from other ranges.

Ultra 4.2 may include `extras.strategyStopPrice` and `extras.strategyStopMode` with an entry. Bridge displays this as an informational **Strategy stop** only when no root `stopLoss` was supplied. It is never filled into native Tradovate stop fields; a `close_confirmed` strategy stop preserves Ultra's close-confirmed broker-stop omission.

## Local development

```bash
cp .env.example .env
# Set ADMIN_API_KEY to a random value at least 24 characters long.
npm install
npm run create-user -- trader@example.com
npm run dev
```

The user creation command outputs a per-user webhook URL and an extension token for extension-only delivery. For account routing, lifecycle journaling, and reapply, configure the shared `/proxy/:secret` endpoint and range routes described below. Build the optional extension with `npm run build`, then load `dist/extension` as an unpacked Chrome extension.

## Web dashboard

Set an `INITIAL_USER_PASSWORD` of at least 12 characters and a random `SESSION_SECRET` of at least 32 characters to enable the authenticated dashboard. No credentials are supplied by the application. A newly created user signs in with their email and the shared initial password; on that first successful sign-in, the application stores a per-user salted scrypt password hash instead of the shared password. The session cookie is HttpOnly and lasts seven days.

Open `/` (or `/app`) to view the journal dashboard, configure accounts and their TradersPost destinations, and assign range routes. A new account has no TradersPost destination until one is configured. Set `ADMIN_USER_EMAIL` explicitly for the administrator; the current server falls back to the first stored user when it is unset. The journal uses fixed UTC-4 dates and modeled lifecycle P&L, with account balances, administrative corrections/exclusions, and optional broker-snapshot reconciliation. Treat destination webhook URLs as secrets.

**Alert activity** lists only proxy-routed alerts that produced an account delivery, with Bridge draft and TradersPost processing states. Legacy per-user direct webhook alerts cannot be assigned to an account, so they are excluded; lifecycle events are also excluded because they do not create proxy deliveries.

If either required dashboard setting is missing, `/login` returns a clear `503` and web login is unavailable. Apart from the account-level TradersPost destination API documented below, existing `x-admin-key` APIs, webhook endpoints, extension APIs, and proxy range routing remain unchanged.

## Forex Factory weekly imports

The bridge now serves imported Forex Factory weekly snapshots for **daily or weekly-range economic-calendar events**:

```text
GET /api/forex-factory/events
```

Query parameters:

- `day` — optional; defaults to `today`. Accepts `YYYY-MM-DD` or ForexFactory day format like `aug9.2026`.
- `range` — optional. Accepts `YYYY-MM-DD:YYYY-MM-DD` or ForexFactory range format like `aug9.2026-aug14.2026`.
- `impact` — optional; defaults to `high`. Use `all` to include non-red-folder events.

Use either `day` or `range`, not both. The response includes the source timezone, import timestamp, and normalized event rows from the stored weekly snapshot. Import the current week either from the authenticated settings page as the admin user by pasting weekly page source into the Forex Factory panel, or from the Chrome extension with **Import current Forex Factory week**, which opens the current week in a browser tab and uploads the rendered HTML through the saved extension token. If a requested week has not been imported yet, the endpoint returns `404` instead of making a live upstream scrape.

## Proxy range routing

Set `PROXY_WEBHOOK_SECRET` to enable the shared proxy endpoint:

```text
POST /proxy/:secret
```

The endpoint accepts the same Ultra/TradersPost payload as a user webhook and routes only exact, case-sensitive `extras.rangeName` matches configured through the admin API. It audits every accepted alert, can create extension drafts for each routed user, and forwards the original validated JSON to that route's selected account's configured TradersPost destination only when `traderspostEnabled` is set. Delivery attempts and explicit success, failure, and not-configured statuses are retained. If `PROXY_WEBHOOK_SECRET` is unset, the endpoint returns `503` while the rest of the app continues to run.

Configure an account destination with the admin API:

```text
PUT /admin/traderspost-destination
x-admin-key: ...

{ "accountId": "ACCOUNT_ID", "webhookUrl": "https://..." }
```

The response is `{ "accountId": "ACCOUNT_ID", "configured": true, "updatedAt": "..." }` and never returns the URL. This endpoint intentionally uses `accountId` rather than the former user-level destination contract.

### Failure-email ingest

Set `EMAIL_INGEST_SECRET` to enable the generic email ingest endpoint:

```text
POST /email/:secret
```

This secret is dedicated on purpose — `PROXY_WEBHOOK_SECRET` is embedded in every TradingView webhook URL, so it must not also authorize a path that can mutate `broker_orders`. If `EMAIL_INGEST_SECRET` is unset, the endpoint returns `401` for every request.

### ULTRA lifecycle ledger payloads

The same proxy endpoint also accepts ULTRA lifecycle events, including ULTRA 5.1. Lifecycle events are routed by `extras.rangeName` and do not create extension drafts or forward the lifecycle JSON to TradersPost. The proxy audits them and records journal events. `entry_filled` is bookkeeping-only. A `trade_closed` can generate instrument-scoped cleanup and replacement entry orders when the destination's `reapplyOnTradeCloseEnabled` setting is on. Journal event deduplication is not a guarantee of completed broker execution. See `AGENTS.md` for the current flow and limitations.

ULTRA `trade_closed` events supply modeled P&L and outcomes to the journal. Bridge reconcile/flatten paths can also generate close bookkeeping, and administrative adjustments/exclusions are supported. Journal results are not independent confirmation of broker fills, commissions, or slippage.

ULTRA 5.1 always emits lifecycle alerts. After updating the script, recreate the TradingView alert as **Any alert() function call** using the proxy webhook; updating the chart alone does not update an existing alert snapshot. The range must have a configured Bridge range route for account bookkeeping. Lifecycle prices and P&L describe Pine's model, not confirmed broker fills.

Send JSON in this shape for a closed trade:

```json
{
  "eventType": "trade_closed",
  "eventId": "ultra-4.2:sim-2026-07-31-000184:closed",
  "tradeId": "sim-2026-07-31-000184",
  "ticker": "MNQ1!",
  "side": "long",
  "action": "exit",
  "quantity": 2,
  "entryPrice": 23124.25,
  "exitPrice": 23133.5,
  "closedAt": "2026-07-31T14:42:18.000Z",
  "realizedTicks": 37,
  "realizedDollars": 185,
  "outcome": "win",
  "extras": {
    "rangeName": "Opening Range"
  }
}
```

All lifecycle payloads require `eventType`, a stable `eventId`, `tradeId`, `ticker`, positive `quantity`, `extras.rangeName`, and side/action context. Supported event types are `entry_armed`, `entry_filled`, `entry_cancelled`, `exit_filled`, and `trade_closed`. `side` is `long` or `short`; `action` may be `buy`, `sell`, `cancel`, or `exit`. Supplying both is recommended, and `cancel`/`exit` events need `side` when their action cannot establish it. Non-close events can include optional ISO `occurredAt`, entry price, and exit price. A close additionally requires ISO `closedAt`, signed `realizedTicks`, signed `realizedDollars`, and outcome `win`, `loss`, or `breakeven`.

`entryPrice` and `exitPrice` are optional positive finite JSON numbers. Quantity is a positive finite JSON number. Realized ticks and dollars are signed finite JSON numbers with no more than two decimal places; the bridge converts both to integer hundredths before storage. Dollar amounts are rejected when their cent value is outside JavaScript's safe-integer range (`abs(dollars × 100) > 9007199254740991`). Stored monetary cents and aggregate P&L are exact; dashboard average win/loss values are rounded to the nearest cent for display.

The journal API is `GET /api/journal?userId=USER_ID` with the `x-admin-key` header. It returns only that user's aggregated journal and closed-trade history; it does not expose raw proxy alerts, destination URLs, webhook URLs, or tokens.

`GET /api/accounts/ACCOUNT_ID/alerts` with the same `x-admin-key` returns the selected account's sanitized proxy-alert activity and summary counts. It derives the owner from the account ID and never returns payload JSON, webhook URLs, destination URLs, or tokens.

## Render deployment

`render.yaml` defines a single Node web service with a persistent disk mounted at `/var/data`. SQLite is appropriate only while the bridge remains a single Render instance. Do not scale the service horizontally with this database design.

Set `PUBLIC_BASE_URL` to the deployed HTTPS URL after provisioning so newly created webhook URLs point at the service.

## Onboarding a user

Each user receives a unique TradingView webhook URL and extension token. Do not share either value between users.

1. In the Render service, open **Shell** and create the user:

   ```bash
   npm run create-user -- trader@example.com
   ```

   Save the JSON response securely. It contains the user ID, webhook URL, and extension token.

2. For extension-only delivery, create or edit the ULTRA alert in TradingView:
   - Paste the returned **webhook URL** into the alert's Webhook URL field.
   - Keep the alert message generated by Ultra.
   - Recreate the alert if it was configured with an older webhook URL.

3. On the user's computer, build and load the extension:

   ```bash
   git clone https://github.com/NCMoseley/tradovate-browser-bridge.git
   cd tradovate-browser-bridge
   npm install
   npm run build
   ```

   Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select `dist/extension`.

4. Open the extension from Chrome's toolbar and enter:
   - **Bridge URL:** the deployed Render URL, for example `https://tradovate-browser-bridge.onrender.com`
   - **Extension token:** the token created for this user
   - **Tradovate overlay position:** the preferred screen corner

   Save the connection and approve Chrome's requested host permission.

5. Verify delivery:
   - Visit `https://tradovate-browser-bridge.onrender.com/test` when the bridge has exactly one user. With multiple users, set Render's `TEST_USER_EMAIL` environment variable to the intended test user's email first.
   - Chrome should show a notification and the extension badge count should increase.
   - The user can open the review page or choose **Fill Tradovate ticket**, then manually verify and submit in Tradovate. After submitting, choose **Mark as submitted** in the review page; use **Reject draft** only when the order was not submitted.

`/test/reset` clears all drafts for the test user. With multiple users, it uses `TEST_USER_EMAIL`; otherwise it only works when exactly one user exists.

## Extension distribution

For a few trusted users, **Load unpacked** is the quickest distribution method during development. For easier updates, package `dist/extension` as a ZIP and publish it as an **unlisted** Chrome Web Store extension. Unlisted extensions are not publicly searchable, but anyone with the install link can install them, so the per-user extension token remains the access control.

Before publishing, use a production build without development-only test assumptions and complete the Chrome Web Store listing, privacy, and permission disclosures. A private Chrome Web Store listing restricted to specific people generally requires an organization-managed Chrome environment; it is not needed for this small invite-only setup.

### Sending the extension as a ZIP

On the build machine, create the package:

```bash
npm run package:extension
```

This creates `dist/tradovate-browser-bridge-extension.zip`. Send that ZIP to the user. On Windows, they should extract it, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the extracted `extension` folder. Chrome does not install this ZIP by double-clicking it; it is an unpacked-extension distribution package.

## Credential rotation

Never add webhook URLs or extension tokens to source control. To replace both credentials for a user, send an admin-authenticated request using that user's ID:

```bash
curl -X POST "https://your-bridge.onrender.com/admin/users/USER_ID/credentials" \
  -H "x-admin-key: $ADMIN_API_KEY"
```

The response contains the replacement webhook URL and extension token. Update the TradingView alert and extension settings immediately; the prior values stop working.

## Backup .sqlite file

The `.sqlite` file is stored in the `data/` directory. Back it up regularly to prevent data loss.

```bash
pkill -f 'dist/server/index.js'; sleep 1; scp -o StrictHostKeyChecking=accept-new 'srv-d9l36rj7uimc738fej7g@ssh.oregon.render.com:/var/data/bridge.sqlite*' data/; nohup npm start > /tmp/bridge.log 2>&1 &
```

```bash
   pkill -f "tsx\|node.*server\|vite" 2>/dev/null || true
   ssh srv-d9l36rj7uimc738fej7g@ssh.oregon.render.com "sqlite3 /var/data/bridge.sqlite 'PRAGMA wal_checkpoint(TRUNCATE);'"
   scp srv-d9l36rj7uimc738fej7g@ssh.oregon.render.com:/var/data/bridge.sqlite{,-wal,-shm} /Users/nate/Desktop/tradovate-browser-bridge/data/
   cd /Users/nate/Desktop/tradovate-browser-bridge
   rm -f data/bridge.sqlite-wal data/bridge.sqlite-shm
   npm run dev
```