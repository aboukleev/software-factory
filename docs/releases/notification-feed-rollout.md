# Notification Feed rollout record

Release owner: **Sasha (`@aboukleev`)**. A different operator may execute a step, but this named owner records evidence and makes the final go/no-go decision.

This content-free record stages the release described by [the approved specification](../specifications/notification-feed.md). Never paste Notification content, personal data, tokens, secrets, raw provider responses, or Production recipient identifiers here.

## Scope boundary

Ticket [#27](https://github.com/aboukleev/software-factory/issues/27) prepares deterministic evidence, dark deployment, controls, smoke instructions, and rollback/monitoring procedures. It does **not** provision Knock Production, run Production smoke before that environment exists, or enable creation/Feed presentation for real recipients.

## Version and evidence checklist

The release owner fills every field before go/no-go. Links must point to the approved content-free evidence store.

- [ ] Application commit/deployment version: `________________`
- [ ] Database migration version (includes `0015_watery_ultimo.sql` dark defaults): `________________`
- [ ] Knock Production environment/configuration version: `________________`
- [ ] `student-question-created` workflow version: `________________`
- [ ] `staff-reply-created` workflow version: `________________`
- [ ] Feed response-filter version/hash: `________________`
- [ ] Enhanced security and least-privilege secret inventory verified: `________________`
- [ ] Backup identifier and restore verification: `________________`
- [ ] Credential-free gate output (`npm run verify:notification-release`): `________________`
- [ ] Isolated Knock Development contract output and cleanup proof: `________________`
- [ ] Content-free soak/fault evidence and sample size: `________________`
- [ ] Telemetry dashboard/version and content-free field review: `________________`
- [ ] Alert configuration and delivery-test evidence: `________________`
- [ ] Production smoke evidence and cleanup proof: `________________`
- [ ] Global-control rehearsal evidence: `________________`
- [ ] Rollback rehearsal evidence: `________________`
- [ ] Known limitations reviewed, including ADR 0002 provider residue: `________________`
- [ ] Timestamped decision: `GO / NO-GO — __________ UTC — Sasha (@aboukleev)`

No-go is the default while any field is blank, any pause criterion is active, Production is unprovisioned, or smoke cleanup is unverified.

## Required gates

Run the credential-free aggregate gate from a clean checkout. Its command order is intentional:

```sh
npm run verify:notification-release
```

It runs typecheck, unit/service tests, production build, migration-and-seed validation, explicit offline Knock workflow validation, and Playwright browser tests. The Playwright suite includes desktop 1280×800 and narrow 390×844 coverage; its Axe checks fail on serious or critical violations.

Then run the explicitly opt-in Development contract with the isolated Development credentials. It creates a random disposable recipient, verifies enhanced security, scoped grants, response filtering, workflow creation, unread/read state, cursor pagination, real-time hints, idempotency, provider references/outcomes, reversible archive, and whole-User permanent deletion. The suite's `afterAll` deletion is a second cleanup attempt even after a test failure.

```sh
NOTIFICATION_PROVIDER_MODE=knock \
KNOCK_SECRET_API_KEY=... \
KNOCK_PUBLIC_API_KEY=... \
KNOCK_SIGNING_KEY=... \
KNOCK_FEED_CHANNEL_ID=... \
npm run test:knock-contract
```

Record the environment identifier, workflow/config versions, UTC start/end, result, disposable recipient correlation ID, and verified zero remaining messages. Do not record credentials or content.

## Content-free soak and fault exercise

Use a dedicated non-Production test database and synthetic recipients. Keep creation and presentation disabled outside the exercise boundary.

1. Start the aggregate stream with `npm run notifications:soak-report -- --samples=40 --interval-ms=15000` and retain only its JSON-lines content-free output.
2. Enable creation only for the synthetic path, generate a meaningful sample through the normal discussion seam, and confirm dispatch is healthy.
3. Inject a bounded fault by pausing dispatch, wait longer than the 15-second poll interval, confirm durable backlog and the expected alert, then restore dispatch.
4. Confirm the first-attempt percentage within 30 seconds, stored-within-one-minute percentage (target at least 95), and stored-within-five-minutes percentage (target at least 99). Percentiles are aggregate evidence, never individual-test assertions.
5. Confirm backlog returns to zero, no unknown outcomes/duplicates/privacy incidents exist, disable creation and presentation, and remove synthetic local/provider data.

Record sample size, fault window, objective results, backlog recovery time, cleanup result, UTC timestamps, application/workflow versions, and limitations. A fake-provider rehearsal proves Cadence measurement and control behavior; it does not replace the Development contract or Production smoke.

## Dark deployment and rehearsal

Migration `0015_watery_ultimo.sql`, schema defaults, missing-row fallback, and seed data set `creationEnabled=false`, `dispatchEnabled=true`, and `feedEnabled=false`. Applying the migration also forces existing creation and Feed controls dark. Before deployment, capture a backup and prove its restore in the target environment.

After dark deployment:

1. Verify creation and Feed/token presentation are false before serving traffic. No historical scan or backfill job may run.
2. Verify the dispatcher heartbeat, empty/new backlog expectations, telemetry fields, and alert delivery while Feed/token endpoints remain unavailable.
3. Rehearse each persisted control without redeployment: creation off/on/off, dispatch on/off/on, and Feed off/on/off. Finish dark: creation false, dispatch true, Feed false.
4. Verify disabling creation does not break discussion writes, disabling dispatch preserves work, and disabling Feed blocks presentation and token issuance.
5. Record before/after state, operator, reason, UTC timestamps, and content-free evidence.

## Controlled Production smoke (procedure only)

Do not run this procedure until Knock Production has been provisioned separately with isolated least-privilege credentials, enhanced security, the approved response filter, and promoted versioned workflows. Do not enable automatic Notification creation or ordinary Feed presentation.

1. Confirm controls are `creation=false`, `dispatch=true`, `feed=false`; record versions and a pre-smoke backup.
2. Allocate two dedicated Production test recipients with no real discussion content. Record only approved opaque correlation IDs.
3. Through the authenticated dedicated smoke path, issue a short-lived token and verify its subject, expiry, explicit `user/feed_read`/`user/feed_write` grants, rejection without a valid signed token, cross-recipient rejection, and the response allowlist.
4. Trigger each promoted workflow once with synthetic allowlisted identifiers and stable idempotency keys. Verify one Feed item per logical occurrence, request/run references, provider acceptance and delivered outcome, occurrence time, unread count, cursor behavior, and idempotent replay.
5. Verify a metadata-only real-time hint causes reconciliation; verify explicit read mutation; verify authorized deep-link resolution and neutral rejection for tampered/cross-recipient identifiers.
6. Archive one item and verify it leaves the Feed; unarchive it to prove ADR 0002's reversible-residue limitation. Do not describe archive as deletion.
7. Hard-delete the disposable Knock Users and verify all associated messages are permanently absent within the provider's documented asynchronous window. Remove Cadence smoke records and confirm no test Event, Delivery, recipient, message, or secret remains.
8. Reconfirm ordinary controls are still `creation=false`, `dispatch=true`, `feed=false`, backlog is empty, and no privacy/configuration/duplicate alerts fired.

Any cleanup uncertainty is an immediate no-go. Production provisioning, this smoke's execution, and actual enablement are not performed by ticket #27.

## Go/no-go and one-step global enablement

The release owner checks every item above and confirms no pause criterion. Record the timestamped decision before changing controls. The one deliberate global step is one durable control update setting `creationEnabled=true`, `dispatchEnabled=true`, and `feedEnabled=true`. Do not introduce an allowlist, recipient canary, timed cohort, historical scan, or backfill.

The exact commit time of that update is the launch boundary. Only qualifying Questions committed after that boundary, and qualifying Replies to Questions created under the post-launch contract, may produce Notifications.

## Immediate pause criteria

Pause immediately for any of these conditions:

- cross-recipient exposure or authorization bypass;
- source content, personal data, tokens, or secrets in Knock responses, telemetry, logs, or evidence;
- duplicate logical Notifications or confirmed physical duplication;
- invalid signed-token grants, enhanced-security state, or response filtering;
- unverified archive/account erasure or unexpected provider residue beyond ADR 0002;
- absent dispatcher heartbeat, sustained old backlog, unresolved outcomes, or sustained objective failure;
- widespread Feed, Read Notification, reconciliation, or deep-navigation failure.

First set creation and dispatch false. For any privacy, authorization, filtering, or client-isolation concern, also set Feed false immediately. Preserve evidence and durable records. Resume only after verified repair and only for eligible original work still within its 24-hour window; never manufacture replacement Events.

## Rollback

1. Atomically pause creation and dispatch; disable Feed/token presentation when containment or client failure requires it.
2. Record control state, UTC time, deployment/workflow versions, backlog, alerts, and content-free incident correlations.
3. Roll application code forward to a compatible known-good version. Do not reverse schema destructively.
4. Preserve Notification Events, Deliveries, attempts, and accepted/delivered provider references. Leave valid Knock Notifications intact.
5. Reconcile accepted/unknown outcomes. Requeue only when provider evidence proves no Notification exists and the original Event remains under 24 hours old.
6. Permanently delete provider data only for account erasure or a verified privacy incident. Ordinary 90-day expiry uses archive under ADR 0002.
7. Restore dispatch, then creation and Feed, independently and only after their risk is resolved. Record the rollback rehearsal and resulting dark state before launch.

## Monitoring record

Monitor continuously for the first 24 hours after enablement. Use aggregate, content-free views only.

### One-hour review

- UTC timestamp/operator: `________________`
- dispatcher heartbeat; due/in-flight backlog and oldest due age: `________________`
- first-attempt, one-minute, and five-minute latency objectives: `________________`
- provider failures, unresolved acceptance, and unknown outcomes: `________________`
- authorization failures and token/filtering signals: `________________`
- logical/physical duplicates and privacy/erasure signals: `________________`
- Feed/read/navigation health and decision to continue/pause: `________________`

### 24-hour review

- UTC timestamp/operator: `________________`
- dispatcher heartbeat; due/in-flight backlog and oldest due age: `________________`
- first-attempt, one-minute, and five-minute latency objectives: `________________`
- provider failures, unresolved acceptance, and unknown outcomes: `________________`
- authorization failures and token/filtering signals: `________________`
- logical/physical duplicates and privacy/erasure signals: `________________`
- Feed/read/navigation health, limitations, incidents, and final decision: `________________`
