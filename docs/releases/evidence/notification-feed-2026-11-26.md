# Notification Feed implementation evidence — 2026-11-26

This record is content-free. It covers ticket [#27](https://github.com/aboukleev/software-factory/issues/27) on base commit `732ab79ed0839099a68b83b1ec36d2b6be49bd21`. It is implementation evidence, not authorization to provision Production or enable the feature.

## Dark-deployment defaults

- Missing control row: creation disabled, dispatch enabled, Feed/token presentation disabled.
- Schema and seed: the same dark state.
- Migration: `0015_watery_ultimo.sql` changes defaults and forces existing creation/Feed values false while preserving the dispatch value.
- TDD evidence: the missing-row default test and aggregate-gate script test were observed failing before implementation and passing afterward.
- Migration/seed replay: passed again at `2026-11-27T04:35Z`; 27 tables were migrated and the full development seed completed.
- Schema drift check: `npm run db:generate` reported no schema changes after migration `0015`.
- Browser setup explicitly enables all three controls only after the dark seed has completed; this keeps the deployed seed contract dark while allowing isolated end-to-end Notification scenarios.

## Knock Development contract

- Environment: isolated Knock Development, credentials loaded locally from the main checkout; no credentials or values recorded.
- Command: `npm run test:knock-contract` with explicit `NOTIFICATION_PROVIDER_MODE=knock`.
- UTC start: `2026-11-27T04:40:35Z`.
- UTC end: `2026-11-27T04:41:19Z`.
- Result: **passed**, 1 file / 2 tests, 43.68 seconds.
- Verified contract: browser runtime, enhanced-security rejection of unsigned access, explicit feed grants, response filtering, both workflows, unread/read state, cursor pagination, real-time hint, stable idempotency, request/run and delivered outcome references, reversible archive, and whole-User permanent deletion.
- Cleanup: the suite hard-deleted its random disposable recipient and waited until the recipient had zero provider messages; the final cleanup hook accepted only successful deletion or already-absent state.

## Controlled content-free soak/fault rehearsal

UTC run: `2026-11-26T18:11Z`. Environment: isolated in-memory SQLite using production Drizzle migrations; deterministic synthetic IDs/payloads and no provider calls. This validates Cadence's aggregate measurement, alert, containment, and cleanup behavior. It does not replace the live Development contract or controlled Production smoke.

Healthy sample (100 synthetic delivered records):

- first attempts within 30 seconds: **100%** (objective: first attempt within 30 seconds);
- stored within one minute: **96%** (objective: at least 95%);
- stored within five minutes: **100%** (objective: at least 99%);
- due/in-flight backlog: **0/0**; dispatcher heartbeat age: **0 ms**;
- permanent failures, unknown outcomes, cancellations, duplicates, unresolved acceptance: **0**;
- alerts: **none**.

Injected dispatch-pause fault:

- five synthetic due records were held for 360,001 ms;
- observed backlog: five due, oldest due age 360,001 ms;
- expected alert: `oldest_due_over_five_minutes`;
- containment/cleanup removed the five disposable fault records;
- final due/in-flight backlog: **0/0**; remaining fault records: **0**.

Percentiles are recorded as aggregate rollout evidence and are not asserted as flaky individual tests. The rehearsal uses deterministic timing; a real provider latency sample remains required in the controlled Production smoke before global enablement.

## Credential-free repository gates

Final aggregate run: `2026-11-27T04:41Z`–`2026-11-27T04:43Z` against integration commit `732ab79ed0839099a68b83b1ec36d2b6be49bd21`.

- `npm run typecheck`: **passed**.
- `npm run test`: **passed**, 31 files / 506 tests; includes explicit offline validation of two privacy-safe Knock workflows.
- `npm run build`: **passed**.
- `npm run db:seed`: **passed**; full migration replay and dark control seed completed.
- `npm run validate:knock`: **passed**, two workflows.
- `npm run test:e2e` (Playwright + Axe): **passed**, 12 tests across desktop and narrow Chrome; serious/critical Axe violations: zero.
- Aggregate command `npm run verify:notification-release`: **passed** in the required repository order.

## Manual and out-of-scope evidence

- Release decision: **NO-GO** until the release owner completes every blank target-environment field in the rollout record.
- Production Knock environment/version: not provisioned; outside ticket #27.
- Controlled Production smoke: procedure documented, not run because Production is not provisioned.
- Backup/restore, telemetry dashboard, alert delivery, global-control rehearsal against a deployed target, rollback rehearsal, go/no-go, actual enablement, and 1-hour/24-hour reviews: release-owner steps that require the target deployment; intentionally not fabricated.
- Manual screen-reader, zoom, forced-colors, on-screen keyboard, and breakpoint review: voluntary/non-blocking under the approved specification; not performed in this implementation worktree.
