# Changelog

Release notes for the Go edition of FastPool EasyMining. See [README.md](README.md) for current installation and usage instructions. Notes describe the behavior introduced in each release; [API-AUDIT.md](API-AUDIT.md) retains the dated provider investigation.

## GitHub automation update — 2 November 2026

- Added Go vet/race tests, JavaScript regressions, Docker builds, isolated startup checks, and downloadable workflow artifacts.
- Added automatic releases for matching version tags or release updates on `main`, with a manual Run workflow option.
- Included the static Linux amd64 binary, installable distribution, full source, build metadata, and SHA-256 checksums in releases.
- Included the repository's MIT license in both packages and retained the runtime version at `2.2.4-go`.

## Documentation update — 1 November 2026

- Reorganized the README for GitHub with setup, configuration, workflows, accounting, upgrades, backups, and troubleshooting.
- Added seven actual UI screenshots using illustrative paper data.
- Added complete Go source and screenshots to the GitHub source package; included documentation assets in the binary distribution.
- Kept the runtime version at `2.2.4-go`; application behavior is unchanged.

## 2.2.4-go

- Made live arming inspect the same current-order scope as sync, purchase guards, accounting, and diagnostics.
- Superseded shared-execution aliases retain their audit records but no longer create contradictory arming holds after history has verified successfully.
- Kept current ownership holds, unverified commitments, and unknown/submitting purchases blocking. Arming does not start the engine.
- Added BTC/USDT regression cases for real team-import alias retirement and legacy supersession markers.

## 2.2.3-go

- Coordinated all in-process SQLite writers, including buying-lease renewal and Telegram outbox updates.
- Reserved the ledger write transaction at its start to avoid deferred snapshot/write conflicts; retained WAL reads and the busy timeout.
- Let successful sync clear old storage-error waits without resetting the ledger or replaying purchases.
- Included the underlying local storage reason and SQLite codes in arming diagnostics.

## 2.2.2-go

- Applied the selected API format consistently to private package/team lists, details, rewards, and saved-address reads.
- Added a cached, read-only alternate-gateway attempt for private history GETs after HTTP 404/code 110. Purchase routes and POST replay behavior are unchanged.
- Preserved nonblocking background verification for accepted team-level purchases found through shared reward references.
- Displayed actual sync phases, retry status, completed-attempt timestamps, and sanitized global history warnings.

## 2.2.1-go

- Matched individual order detail reads to the selected request namespace.
- Scoped delayed details for a successfully accepted team purchase to that team while retaining its full commitment and purchase count.
- Allowed a verified private team index snapshot to establish personal spending when individual details are delayed.
- Added pending-sync details and sanitized diagnostic references. Unknown POST outcomes and real spending/ownership conflicts continue to hold buying.

## 2.2.0-go

- Added optional Telegram alerts for accepted live manual purchases, strategy purchases, and team additions through the application.
- Added previous-local-day reports with separate BTC/USDT accounting, personal reward quantities, pending values, and USD/EUR estimates.
- Added encrypted instance-local bot settings, test/preview actions, and a persistent delivery outbox independent of the buying engine.
- Imported website purchases contribute to reports without replaying purchase alerts. Temporary notification failures do not retry NiceHash purchases.

## 2.1.1-go

- Kept lifetime strategy budget and maximum purchases editable in both markets, including continuous mode.
- Showed actual spending and purchase counts against targets, including percentages beyond 100%.
- Retained optional enforced lifetime limits when continuous mode is disabled.

## 2.1.0-go

- Added continuous buying until a strategy is paused, subject to global limits, schedules, reserves, concurrency, and verification checks.
- Added USDT solo/team catalogues, strategies, account imports, balances, spending journals, limits, daily reports, and CSVs separately from BTC.
- Retained personal reward coin quantities and recorded market valuations; left missing rates unpriced instead of assuming USDT equals USD.
- Kept documented/web cumulative team additions and Guide first-join-only behavior.

## 2.0.4-go

- Handled definitive HTTP 400/code 5251 (`SHARED_TICKET_INVALID_STATE`) as an exclusion of the rejected team rather than pausing every strategy.
- Preserved already paid shares after a rejected addition. Other eligible teams can continue within normal controls.
- Recognized saved 5251 failures after upgrade without deleting records or retrying those teams.

## 2.0.3-go

- Added explicit Documented (`/main`), Web client (`/hashpower`), and Guide (shares-only) purchase request profiles.
- Preserved the documented default and required explicit review, arming, and start after changing formats.
- Kept one POST to the selected route, with no automatic route fallback or purchase replay.
- Added binary `--version` and UI/server version mismatch checks. The operator subsequently reported working purchases with the Web client profile.

## 2.0.2-go

- Added expiring purchase debug capture, per-stage traces, request fingerprints, provider references, and downloadable sanitized logs.
- Excluded credentials, signatures, organization IDs, payout values, 2FA, and wallet balances.
- Kept debug capture independent of buying authority and purchase outcomes.

## 2.0.1-go

- Added the read-only API/accounting audit and provider error references.
- Corrected live team duration, dated paper-level fee releases, and exclusion of orphaned/donated rewards.
- Verified personal member reward treatment and exact fractional aggregation against captured response fixtures.

## Initial Go edition

- Introduced the native Go server with embedded browser assets, vendored SQLite, and a standalone Linux amd64 distribution.
- Retained migration support for the existing ledger, password format, encrypted credentials, strategies, rewards, and spending history.
- Preserved explicit live arming, startup pause/disarm, durable purchase reservations, and uncertain-outcome reconciliation.
