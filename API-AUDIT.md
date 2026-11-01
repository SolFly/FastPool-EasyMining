# NiceHash response and accounting audit — updated 29 October 2026

This investigation used NiceHash’s published REST schema, live **public** JSON responses, current web-client source and the actual FastPool Go code. No user credentials were available here. No authenticated or funded purchase was attempted. Anonymous routing probes used an all-zero nonexistent UUID and an empty body, with no account credentials.

## USDT support verified on 29 October 2026

Read-only public catalogue responses contained USDT Silver 5 and Silver 20 solo packages (5 and 20 USDT) and Team Silver USDT / Team Gold USDT (1 USDT minimum share). The official hashpower OpenAPI schema accepts `buyWithCurrency` for solo requests and defines `currencyMarket` on account orders. Its shared-ticket request uses native `amount` and shares, with payment currency determined by the team ID. No private currency field was invented. The stripped public USDT fixture is retained under `internal/controller/testdata/nicehash-usdt-2026-10-29.json`.

Version 2.1.0-go separates BTC and USDT wallets, monetary guards, account imports, spend journals, P&L, daily reports, CSVs and audits. Amounts use 1e-8 units in their declared currency. Reward coin quantities remain personal net payouts. USDT valuation uses the account BTC/USDT rate, with confirmed values retained and missing rates left unpriced. Fiat conversion follows available exchange-rate edges rather than assuming a dollar peg. These checks and signed purchase flows were tested against mocks; no funded USDT order was placed.

The historical observations below describe the 28 October investigation. Statements about excluded USDT entries describe the earlier version; supported USDT entries are imported in 2.1.0-go.

## The reported Silver failure

The reported target `f9255b2f-a6fd-43d7-b82e-3502b037bf94` was present in the captured public team catalogue. The response had:

| Field | Captured value |
| --- | --- |
| Team ID | `f9255b2f-a6fd-43d7-b82e-3502b037bf94` |
| Package template ID | `370688a7-5de1-4171-889e-96567993fcb4` |
| Name / payment / reward | Team Silver / BTC / BCH |
| Status / state | COUNTDOWN / OPEN |
| Minimum share price | 0.0001 BTC |
| Total committed | 0.0006 BTC = 6 small-share equivalents |
| Buy deadline reported | 2026-10-28 09:31:10 UTC = 11:31:10 Sofia |
| Current duration | 3600 seconds |

The user’s rejection was at 11:12 Sofia. This later catalogue observation is evidence that the ID was still being advertised, not proof of its internal state at the moment of the POST.

For a strategy with its first threshold at 5 and quantity 1, the first-join plan generated from that response is:

```http
POST /main/api/v2/hashpower/shared/ticket/f9255b2f-a6fd-43d7-b82e-3502b037bf94
```

```json
{"amount":0.0001,"shares":{"small":1},"clear":false}
```

That body is identical with levels disabled for an ordinary one-share join. The first level does not need the owned-addition detail read. Later levels use verified **cumulative** commitment and quantities, consistent with the current NiceHash web client. Each addition has a different request ID; the local ledger reserves only its incremental cost. Coupons/mass-buy participation is not silently adopted into this flow.

These source/fixture checks do not prove the exact historical body, destination fields, permissions or organization context of the user’s rejected request. The new audit exposes current plans and retained request evidence to make those differences reviewable.

## Documentation versus observed routing

The REST schema lists the team buy operation under the `/main` production server and identifies the public team catalogue as the ID source. NiceHash’s current web client uses the `/hashpower` namespace for team details and purchases.

Observed without credentials:

| Request | `/main` result | `/hashpower` counterpart |
| --- | --- | --- |
| GET public solo/shared/order | 200 | 200 |
| GET public/easymining/packages | 404 / 110 | 401 / 2000 |
| GET public/hashpower/solo/teams/public | 404 / 110 | 401 / 2000 |
| POST shared/ticket/all-zero-UUID, empty JSON | 401 / 2000 | 401 / 2000 |
| GET private shared/order/all-zero-UUID | 401 / 2000 | 401 / 2000 |
| POST solo/order, empty JSON | 401 / 2000 | 401 / 2000 |

The anonymous private-route responses do **not** establish that either route will accept API-key purchases. They therefore do not justify switching purchase routes or retrying a failed funded request. The default FastPool format retains the documented route; explicitly selectable alternatives are described below. There is no automatic fallback/replay.

## Statistics findings and corrections in 2.0.1-go

1. **Team duration:** the old normalizer used the template’s maximum duration. Captured Team Gold reported 1 hour while its template said 4 hours; Bronze reported 1 versus 3 hours. The normalizer now prefers the live team’s `duration`, falling back to the template only when absent.
2. **Paper level spending dates:** clearing the fee buffer directly could make the saved spend-history sum disagree with the order total. The compatibility fallback then assigned the whole commitment to the first purchase date. Paper levels now release their buffers through the dated spending journal, just as live levels do. Existing inconsistent histories are flagged by the audit rather than silently rewritten.
3. **Orphaned and donated rewards:** reference quantities remain available in source records, but confirmations of -1, donation flags and explicit exclusions are consistently omitted from earned/pending P&L, coin totals, daily reports, financial CSV and stop-on-win decisions. Historical donation flags become available when the next private sync returns them. NiceHash’s web client also excludes orphaned blocks from reward aggregation.
4. **Personal team rewards:** the member’s `rewardAmount` is already the payable net. The current NiceHash client adds the separately reported fee to reconstruct a gross reference; it does not subtract it from the net again. FastPool continues to use the verified member’s contribution and net reward, not a full block or a whole team payout. Fractional quantities are summed exactly and rounded down once to 1e-8 coin units.
5. **Conversions and daily totals:** captured rates were exercised for BTC, BCH, LTC, DOGE and ZEC in both USD and EUR. Pending rewards remain separate. Confirmed BTC accounting values remain frozen; current coin spot estimates can differ from translating that BTC ledger. Local calendar dates, additions/refunds, unpriced rewards, superseded executions and ownership holds remain respected.
6. **Provider error references:** new failures retain NiceHash’s `error_id` in addition to the application request ID, code, path and timestamp. Older failures cannot retroactively acquire an omitted provider error ID.

## One read-only account audit

After upgrading, open **Activity log → Run API audit**. It downloads `easymining-api-audit.json` in one action, even if individual reads fail. It does not buy, retry, arm/disarm or change configuration. It temporarily holds the normal evaluation lock; the engine can resume its previously configured behavior afterward.

The audit contains:

- Public catalogue IDs, template IDs, prices/share counts and actual/template durations.
- Signed GET results for the selected team details on both namespaces, without selecting a purchase route.
- Sampled private index shape/ownership counts, payout-address counts by coin and validated balance/rate field types. History probes deliberately sample only the first page and do not certify complete account history.
- First-join versus owned-addition plans, current guard decisions and retained purchase failure references.
- Saved-ledger financial totals, per-coin confirmed/pending/excluded quantities, personal team allocation metadata and daily-versus-lifetime consistency checks.

It excludes API keys, secrets, organization IDs, password/session tokens, 2FA, payout address values, raw private responses and wallet balance amounts. It **does include financial ledger totals and order/team IDs** so they can be reviewed. Source response quantities used for allocation checks belong only to a verified matching member; no first-member ownership assumption is made.

This account-level report is needed to distinguish a public-ID lookup failure in the authenticated API context from a destination/configuration problem. A provider-side trace using NiceHash’s own error ID may still be necessary. The exact cause of the reported purchase 404 remains unproven.

## Evidence and reproduction

A compact, public-only response fixture with original response SHA-256 hashes is included in `internal/controller/testdata/nicehash-public-2026-10-28.json`. Tests consume that fixture rather than manufacturing a catalogue schema. Private-account cases use clearly synthetic responses.

Primary resources fetched during this audit:

- https://www.nicehash.com/docs/rest/-easymining-private
- https://api2.nicehash.com/hashpower/api/v2/info/hashpowerorders-rest-openapi
- https://api2.nicehash.com/main/api/v2/public/solo/shared/order?onlyGold=false&page=0&limit=100
- https://api2.nicehash.com/main/api/v2/public/solo/package
- https://api2.nicehash.com/main/api/v2/exchangeRate/list
- https://www.nicehash.com/my/assets/OrderModal-aDMMqXI9.js
- https://www.nicehash.com/my/assets/main-CdOUppJT.js

The hashed frontend asset names are the versions served at inspection time and may change later. Public market values and team membership also change; captured values are observations, not current quotes or promises of execution.

## Purchase debug capture (2.0.2-go)

The API audit is a read-only snapshot. Purchase debug mode complements it by observing the actual next normal evaluation/request. In Activity log, choose a bounded capture duration and enable it, then inspect or download the retained traces. It does not make a diagnostic purchase, bypass quarantine, start/arm the engine, change request bodies or replay a POST. Trace checkpoints precede the existing HTTP call; matching payout fingerprints connect the saved-address read, destination selection and redacted request field. HTTP responses use a strict summary whitelist, including the provider error ID and sanitized error messages. See README for retention, redaction and operating details.

## Supplied integration guide comparison (2.0.3-go)

The uploaded guide is a source-review document for another application, not a live NiceHash acceptance test. It supplies two independently observable request differences: `/hashpower` versus `/main`, and omission of `amount`/`clear` in team requests. FastPool now exposes three explicit formats so those contracts can be selected in the UI without hidden fallback. See README for the exact field/route matrix and guide first-join limitation. Defaults, ledger identity, price caps, uncertainty holds and existing personal reward accounting are retained. Ordinary strategies now report a prior 404/410 exclusion instead of the generic Package unavailable message. The current 404 still requires provider/account qualification; no funded purchase was made during this change.

## Operator purchase report and state rejection (2.0.4-go, 29 October 2026)

After confirming the deployed server version as 2.0.3-go, the operator reported that the selected `/hashpower` format buys shares. A later attempt returned HTTP 400 / code 5251 (`NiceHashErrorTranslation.SHARED_TICKET_INVALID_STATE`) for team `d5839c67-942a-44fb-be83-16ea5633a191` at 07:33 Europe/Sofia. This is an operator report, not a funded transaction performed during development. The exact timing and state transition are not supplied by this short activity log. NiceHash's TeamMining terms describe lobbies closing when their time expires or all shares are sold, but those possibilities do not prove the cause of this particular response.

Source review found that the engine's target-specific rejection branch only covered HTTP 404/410. A 5251 response therefore fell through to the general pause/disarm path. This release narrowly classifies a definitive HTTP 400 / code 5251 on a known team purchase POST as a team exclusion, records a warning and continues other eligible strategies. It retains a follow-up catalogue check as evidence, never as permission to replay the POST. First joins and additions retain the existing rollback rules; uncertain submissions and other errors still pause. Retained state rejections exclude that exact team across formats; 404/410 exclusions remain scoped to their route and known format. There is no route, payload or payout change in this release.


## 31 October 2026 · history GET compatibility (2.2.2-go)

Private history list, detail and reward reads start with the explicitly selected gateway. Only a GET rejected with HTTP 404/code 110 may try the same resource once through the other NiceHash gateway. A successful route is cached per history resource type, and the attempted paths are included in sanitized diagnostics. This read-only compatibility does not apply to POST, authentication failures, outages, public catalogue or balances. Purchase endpoints, request bodies, profile selection and no-replay behavior are unchanged. Global history warnings and sync phases are now exported even when no local order is attached to the failed read.


## 31 October 2026 · local storage contention (2.2.3-go)

The operator's diagnostic identified a local `database is locked` warning on a completed team, rather than a provider rejection. Regression tests reproduced the read-snapshot/write-upgrade failure with concurrent lease renewal and notification-status writes. Ledger batches now take the SQLite writer at the start and all local mutations queue outside the connection pool. The arming guard is retained, and failed cost writes cannot be downgraded to nonblocking read refreshes. No NiceHash purchase route or body changes were made.


## 31 October 2026 · arming scope (2.2.4-go)

A completed sync with no current issues could still be refused by the arming loop because it inspected superseded shared-execution aliases that retained old review markers. Arming now uses the same current-live-order scope as sync and diagnostics. Archived audit history stays intact and excluded from current spending/rewards. Real current unknown or unverified purchases remain blocked. No provider route, body or purchase replay behavior changed.
