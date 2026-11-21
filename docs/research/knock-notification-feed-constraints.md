# Knock constraints for Cadence's Notification Feed

_Researched 2026-11-21. Scope: the current Knock-hosted, in-app-feed product described by Knock's official documentation and official SDK repository. Cadence terms follow `GLOSSARY.md`; where Knock says “message,” this note means the Knock channel-specific record that implements a Cadence Notification in the Notification Feed._

## Decision summary

Knock can implement Cadence's in-app-only Notification Feed without Cadence building feed storage, badge counts, read-state APIs, or WebSocket infrastructure. It is not, however, a transparent renderer over Cadence-owned Notifications: Knock generates and indefinitely retains immutable feed items, owns their engagement state, and exposes them directly to the browser. The specification therefore needs to make Knock's identity, security, data-exposure, idempotency, retention, and failure boundaries explicit.

The recommended shape is:

1. Cadence emits each Notification Event from its backend through one committed Knock workflow containing one in-app-feed channel step.
2. Each trigger names exactly one recipient (Student or Instructor) by that recipient's stable internal Cadence ID and carries a stable event-derived idempotency key.
3. The browser reads and updates that recipient's feed with Knock's public key plus a short-lived, backend-signed user token restricted to feed read/write grants.
4. Cadence maps its Read Notification to Knock's `read` state, not Knock's `seen` state, and uses `unread_count` for its badge.
5. Cadence treats WebSocket events as refresh hints, not a complete or guaranteed event stream, and reconciles from the paginated feed API.
6. Cadence sends only client-safe trigger data and applies a feed response allowlist.
7. Cadence owns durable dispatch/outbox state and deduplication beyond Knock's 24-hour idempotency window; Knock owns feed-item storage and engagement state.
8. The product must separately decide how long Notifications remain visible, because Knock feed items remain available indefinitely and cannot be edited after creation.

The numbered statements above are **recommendations**, derived from the sourced facts and explicit inferences below.

## 1. Workflow trigger model

### Facts

- A Knock workflow has a unique key, contains function/channel steps and templates, and executes one recipient workflow run per recipient. It can be triggered by an API call, an integration-source event, a schedule, or audience entry. An API trigger can name multiple recipients, but Knock enqueues a separate run for each recipient and returns a top-level `workflow_run_id`. [Workflows](https://docs.knock.app/concepts/workflows), [triggering workflows](https://docs.knock.app/send-notifications/triggering-workflows/overview)
- The API trigger accepts `recipients`, optional `actor`, `data`, `tenant`, `cancellation_key`, and execution settings. A trigger can target up to 1,000 recipients. The in-app message contains workflow data and, when provided, associates the actor with the feed item. [Triggering workflows via the API](https://docs.knock.app/send-notifications/triggering-workflows/api)
- A workflow's in-app channel step generates the feed message. Knock templates render the message content; the trigger payload supplies its runtime data. Published/committed workflow versions are what API triggers execute. [Workflows](https://docs.knock.app/concepts/workflows), [testing workflows](https://docs.knock.app/send-notifications/testing-workflows)
- Recipient preferences are evaluated automatically for every workflow run; unspecified preferences default to enabled. [Preferences overview](https://docs.knock.app/preferences/overview)
- Cancellation only affects a still-running workflow with a pausing step and a `cancellation_key`. It cannot retract a finished feed message; Knock directs callers to archive such a message instead. Cancellation is asynchronous and can race a recent trigger. [Canceling workflows](https://docs.knock.app/send-notifications/canceling-workflows)

### Inferences

- Cadence's ordinary event-driven Notifications fit a direct backend API trigger better than schedules, audiences, or Knock-managed subscriptions: Cadence already knows the recipient when a Notification Event occurs.
- A successful trigger response means recipient runs were enqueued, not that the recipient viewed the resulting Notification.
- Cancellation is not a reliable “undo Notification” mechanism after creation. Feed archival is a visibility change, not erasure.

### Recommendations

- Define one workflow key per stable Notification Event kind, with exactly one in-app-feed channel step unless batching is an explicit product behavior.
- Trigger one recipient per request. This is below Knock's bulk capability but makes idempotency, tracing, authorization reasoning, and partial failure handling unambiguous.
- Put only rendering inputs and navigation identifiers in `data`; keep Cadence business decisions in Cadence. If Notifications must never be opted out of, specify that preference behavior explicitly rather than relying on an unstated default.
- Store the returned `workflow_run_id` alongside Cadence's dispatch attempt for support correlation.

## 2. Recipient identity model

### Facts

- A Knock recipient can be a User or an Object. Users are referenced by an internal identifier from the integrating system; recipients may be identified ahead of time or inline in a workflow trigger. A recipient identifier may be a previously identified user ID string, an Object reference, or a complete inline recipient. [Recipients](https://docs.knock.app/concepts/recipients), [Users API](https://docs.knock.app/api-reference/users/feeds/list_items)
- Identifying an existing user merges supplied properties. Knock recipients and all other data are environment-specific when environments are enabled. [Users API](https://docs.knock.app/api-reference/users/feeds/list_items), [environments](https://docs.knock.app/version-control/environments)
- Fetching a feed for a user Knock has not identified returns an empty feed. Deleting a Knock user permanently deletes that user and associated properties, preferences, channel data, subscriptions, schedules, and messages. [Feed API reference](https://docs.knock.app/api-reference/users/feeds/list_items), [deleting users](https://docs.knock.app/managing-recipients/deleting-users)

### Inferences

- A Cadence recipient (a Student or Instructor in the initial event set) is a Knock User, not an Object. Email is mutable and is therefore unsuitable as the Knock user identifier.
- The recipient's internal Cadence ID must be stable across account/profile and role changes. Reusing an identifier for a different person would expose the first person's retained feed to the second.

### Recommendations

- Use the recipient's internal Cadence primary key, serialized as a string, as the Knock User ID and as the signed token's subject (`sub`). Do not use email or a role-scoped identifier.
- Inline-identify the minimal client-safe recipient properties needed by a template, or synchronize them explicitly. Avoid copying the full Cadence account record.
- Add Knock user deletion to any future Cadence account-erasure workflow. Never recycle internal Cadence IDs.

## 3. Feed API and UI surface

### Facts

- The feed API returns pre-generated feed items in reverse chronological order plus aggregate `total_count`, `unread_count`, and `unseen_count`. It supports cursor pagination (50 items by default), status filters, tenant/workflow/category/custom-trigger-data filters, and archived-item inclusion/exclusion. The feed endpoint is rate-limit Tier 2 (5 requests/second), scoped per user and environment. [In-app API overview](https://docs.knock.app/in-app-ui/api-overview), [Feed API reference](https://docs.knock.app/api-reference/users/feeds/list_items), [API rate limits](https://docs.knock.app/api-reference/overview)
- Knock provides pre-built feed components and lower-level/headless primitives. Its client SDKs cover JavaScript/React, React Native, Flutter, iOS, and Android. [Feeds overview](https://docs.knock.app/in-app-ui/feeds/overview), [custom feed UI](https://docs.knock.app/in-app-ui/feeds/custom-ui)
- A feed item includes rendered content blocks, its Knock message ID, actor(s), workflow source/version/categories, trigger data, timestamps, optional tenant, and engagement timestamps. Compact mode omits activities, nested data, and all but one actor; rich mode returns more. [In-app API overview](https://docs.knock.app/in-app-ui/api-overview)
- Feed content and metadata cannot be edited after generation. Engagement state can change; stale content must be archived and a new workflow triggered. Feed ordering is reverse chronological and cannot be manually reordered or pinned. [Feeds overview](https://docs.knock.app/in-app-ui/feeds/overview)

### Inferences

- Knock can be Cadence's read model for the Notification Feed, but it is not a mutable Cadence Notification record.
- The pre-built component's default behaviors are product choices, not neutral infrastructure; notably, it exposes seen/read/archive interactions that may not match Cadence's specification.

### Recommendations

- Use Knock's React client/store primitives with Cadence UI components, or configure the pre-built components deliberately. Do not inherit default archive controls or badge semantics accidentally.
- Use compact mode unless a specified Notification needs batched activities or nested trigger data.
- Treat the Knock message ID as the feed-item/Notification handle for read and archive actions; carry Cadence resource IDs in a small, client-safe `data` object for navigation.
- Specify empty, loading, error, pagination, and rate-limit behavior. Do not promise pinning, manual ordering, or in-place edits.

## 4. Unread, read, and seen state

### Facts

- Every feed message can be unseen/seen and unread/read. `seen` means the item was retrieved/rendered in the feed; `read` means it was explicitly marked read. The API exposes `seen_at` and `read_at`, aggregate unseen/unread counts, single-message status endpoints, batch status endpoints, and reverse operations (mark unseen/unread). [In-app feeds](https://docs.knock.app/integrations/in-app/feeds), [Messages API](https://docs.knock.app/api-reference/messages)
- Knock engagement statuses are mutually inclusive: a message can be both seen and read. The pre-built feed defaults its badge to unseen, marks items seen when the feed opens, marks an item read when clicked, and supports “mark all as read”; the badge can instead use unread. [Message statuses](https://docs.knock.app/send-notifications/message-statuses), [React feed component](https://docs.knock.app/in-app-ui/react/feed)

### Inferences

- Cadence's glossary definition—“a Notification the recipient has opened or acknowledged”—matches Knock `read`, not `seen`. Merely opening the feed should not silently turn every rendered item into a Cadence Read Notification.
- Knock `seen` is useful telemetry but need not appear in Cadence's domain language or UI.

### Recommendations

- Define unread as `read_at == null`, map Read Notification to `read_at != null`, and drive the badge from `unread_count`.
- Mark one item read when the recipient opens/acknowledges it; offer “mark all as read” only if the product wants it. Decide explicitly whether recipients may mark a Notification unread again.
- Allow the SDK to record `seen` for rendering telemetry, but do not use unseen count as Cadence's unread count.

## 5. Real-time updates

### Facts

- Knock runs the in-app real-time WebSocket service. Its documented socket event is `new-message`; that event may be throttled, contains updated badge metadata, and does not contain the full message. Feed clients can subscribe to real-time item receipt and state changes. [In-app API overview](https://docs.knock.app/in-app-ui/api-overview), [FeedClient reference](https://docs.knock.app/in-app-ui/javascript/sdk/feed-client)
- Cross-browser/tab synchronization in the React feed is an experimental opt-in based on `BroadcastChannel`; clients can also automatically disconnect sockets for inactive tabs and reconnect when active. [React feed component](https://docs.knock.app/in-app-ui/react/feed)

### Inferences

- The socket is not a durable event log and cannot be the sole source of feed truth: notifications can be missed while disconnected, events can be throttled, and the notification body is absent from the event.

### Recommendations

- Treat real-time events as invalidations: update badge metadata promptly, then reconcile/fetch from the feed API. Fetch on initial load, reconnect, and feed open/focus.
- Do not specify exact-once or instantaneous UI delivery. Specify eventual refresh behavior and retain a manual retry path after client/API errors.
- Avoid relying on the experimental cross-tab option for a core guarantee; refetch on tab focus is the simpler correctness backstop.

## 6. Authentication, authorization, and data exposure

### Facts

- Backend Knock API calls use a secret API key; client-side feed calls use a public key. Without enhanced security mode, anyone holding the public key can act as any user. Knock says production environments should enable enhanced security. [Security and authentication](https://docs.knock.app/in-app-ui/security-and-authentication), [API authentication](https://docs.knock.app/api-reference/overview)
- Enhanced security requires a backend-generated RS256 JWT whose `sub` identifies the current user; Knock recommends `iat` and `exp`. Tokens can use explicit grants, including `user/feed_read` and `user/feed_write`; setting `explicit_grants: true` denies undeclared resource access. Tokens can also restrict feed actions to named tenants. [Security and authentication](https://docs.knock.app/in-app-ui/security-and-authentication)
- By default the feed response can contain the entire workflow trigger `data`, public environment variables, recipient custom properties, and actor custom properties. A per-channel API response filter can omit entities or allow/deny key paths; secret variables are never returned. [In-app feeds](https://docs.knock.app/integrations/in-app/feeds)

### Inferences

- Public-key-only mode is an account-isolation vulnerability for Cadence, not merely a weaker optional posture.
- Any sensitive value placed in trigger data or recipient/actor custom properties may reach the recipient's browser unless filtered. The feed is therefore a projection visible to that recipient, not a secret backend payload.

### Recommendations

- Enable enhanced security before any production use. Generate short-lived tokens only after Cadence authenticates the session; set `sub` to the recipient's stable internal Cadence ID and `explicit_grants: true` with only feed read/write grants.
- Keep the signing key and secret API key server-only. Align the Knock token expiry with the Cadence session and refresh it from the backend.
- Configure a response **allowlist** for only the actor, recipient, and trigger-data keys the UI renders. Never put secrets, private course/admin data, or authorization decisions in feed data.
- Keep authorization in Cadence: an action URL is navigation, not proof the recipient may access its target resource.

## 7. Idempotency

### Facts

- `POST /workflows/:key/trigger` is currently the only Knock API endpoint that honors `Idempotency-Key`. The key may be at most 255 characters. Identical successful requests with the same key within 24 hours return the original response; changed parameters produce an error. Only successful `2xx` responses are cached, so a failed request with the same key executes again. The default window can only be changed by contacting Knock. [API idempotency](https://docs.knock.app/api-reference/overview)
- Knock's official Node SDK automatically retries connection errors, HTTP 408/409/429, and 5xx responses twice by default with exponential backoff; timeouts are one minute by default and are also retried. [Official Knock Node SDK](https://github.com/knocklabs/knock-node)

### Inferences

- Supplying no idempotency key while using the SDK can duplicate a Notification when the server commits a trigger but the response is lost.
- Knock's 24-hour cache is retry protection, not permanent business-event deduplication. A replay after 24 hours can create a second Notification.

### Recommendations

- Always send an idempotency key derived from immutable Cadence identity, for example `notification:<event-kind>:<notification-event-id>:<recipient-id>`. Persist that same key across all retries.
- Keep a Cadence outbox/dispatch record with a uniqueness constraint on Notification Event + recipient + workflow. Use it to prevent replay after 24 hours and to retry transient API failures safely.
- Do not mutate a payload while reusing its key. If the event legitimately changes, archive the old item and emit a new Notification Event/key.

## 8. Retention and lifecycle implications

### Facts

- Audit logs, message-log data, outbound-webhook logs, source logs, and workflow-run logs are retained for 30 days on non-Enterprise plans and 90 days on Enterprise. API logs are always retained for 30 days. Custom retention windows are not currently supported. [Data retention](https://docs.knock.app/manage-your-account/data-retention)
- In-app feed notifications remain available indefinitely even after their message logs and metadata age out; recipients can still fetch and change their status. [Data retention](https://docs.knock.app/manage-your-account/data-retention)
- Knock's current pricing page describes feed retention as having no maximum and being configurable, but the reviewed product documentation does not specify the configuration surface or semantics. [Pricing](https://knock.app/pricing)
- Archiving hides an item from the default feed but it remains accessible and can be unarchived. The documented Messages API exposes archive/unarchive but no per-message deletion endpoint. Feed-item content cannot be updated after generation. [Messages API](https://docs.knock.app/api-reference/messages), [Feeds overview](https://docs.knock.app/in-app-ui/feeds/overview)

### Inferences

- Knock log retention does not implement a Cadence Notification retention policy. “Thirty days of logs” and “indefinite feed contents” are different data lifecycles.
- Archival is not deletion or erasure. Indefinite content retention may conflict with a future Cadence privacy/deletion requirement, especially because rendered content and trigger data remain fetchable.

### Recommendations

- The product must choose a visible Notification lifetime and an erasure policy before the specification is complete. If the desired behavior is “keep forever,” state it. If not, confirm Knock's feed-retention configuration semantics or schedule archival; do not represent archive as deletion.
- Minimize personal/sensitive data in rendered content and trigger data. Treat the Knock user-delete operation as the documented full-user erasure mechanism.
- Export operational events Cadence needs beyond 30/90 days to Cadence-owned storage; do not rely on the dashboard as a permanent audit trail.

## 9. Local development and testing

### Facts

- The workflow test runner can run a whole workflow or one channel step with selected recipient, actor, tenant, and data. Sandbox mode generates/previews messages without delivering to underlying providers, and `skip_delay` bypasses delays; both settings are also accepted by API triggers. The test runner uses the last saved draft, while API triggers use the last committed version. Trigger-frequency rules such as “once per recipient” are bypassed in test runs. [Testing workflows](https://docs.knock.app/send-notifications/testing-workflows)
- Knock environments isolate content, users, messages, logs, configuration, and API keys. Enabling environments adds a development environment; additional staging environments and development branches are available. [Environments](https://docs.knock.app/version-control/environments), [branches](https://docs.knock.app/version-control/branches)
- The CLI pulls workflow resources into source control, validates/edits them locally, pushes them to Knock, and can run workflows. Official “local development” still pushes/executes against a Knock environment or branch. [Knock CLI](https://docs.knock.app/developer-tools/knock-cli), [CI/CD local development](https://docs.knock.app/tutorials/integrating-into-cicd)

### Inferences

- Knock's documented development model is cloud-backed; the official sources reviewed do not describe a local Knock server/emulator. A fully offline end-to-end test cannot exercise real Knock workflow rendering, feed storage, or WebSockets.
- Knock explicitly says the in-app channel does not support sandbox mode because there is no downstream provider handoff to suppress; channel conditions must control whether test feed items are created. [Knock plans and usage](https://docs.knock.app/manage-your-account/knock-plans)

### Recommendations

- Use an isolated Knock development environment with test-only recipients and keys. Never point local Cadence at production Knock.
- Unit-test Cadence's event-to-trigger mapping with a mocked adapter. Add a small integration suite against the development environment for trigger, feed retrieval, read state, JWT authorization, idempotency, and reconnect/refetch behavior.
- In tests that must create feed items, use unique test recipient IDs and delete them afterward. Test trigger frequency via the API, not the dashboard runner.
- Use in-app channel conditions—not sandbox mode—to restrict which test recipients receive feed items.
- Keep workflow definitions under version control through the CLI and promote committed versions with application releases.

## 10. Failure and retry behavior

### Facts

- The Knock API uses standard 4xx/5xx responses and endpoint rate limits; 429 means rate limited. Its errors include a stable machine-readable `code`, which Knock recommends branching on rather than the human-readable message. [API reference](https://docs.knock.app/api-reference/overview)
- A workflow step that errors is attempted up to three total times. If it still fails, the run halts and later steps do not execute. A failed run can be manually retried once, within seven days, from its failed step and with the original workflow version; completed steps are not repeated. [Debugging workflows](https://docs.knock.app/send-notifications/debugging-workflows)
- A missing channel, unmet condition, opted-out recipient, or missing recipient data can skip a step rather than fail the run. [Debugging workflows](https://docs.knock.app/send-notifications/debugging-workflows)
- In-app messages automatically reach `delivered` when Knock stores them in the Feed API. That status means delivered to the recipient's feed, not rendered or read by the recipient. [Message statuses](https://docs.knock.app/send-notifications/message-statuses)

### Inferences

- Cadence cannot infer Notification creation from a trigger HTTP success alone; it indicates accepted/enqueued work. Nor can it infer recipient attention from Knock's in-app `delivered` state.
- Knock's internal step retries do not replace retrying a failed/unknown trigger call from Cadence, and the dashboard-only manual retry is not an adequate automated reliability policy.
- A skipped in-app step can look like a completed run with no Notification, so monitoring only workflow errors is insufficient.

### Recommendations

- Classify API failures: do not retry validation/auth/not-found errors until configuration is fixed; retry connection failures, 408/409/429, and 5xx with bounded exponential backoff and the same idempotency key. Respect SDK behavior to avoid nested retry storms.
- Keep failed/unknown dispatches in a Cadence outbox for automated retry and alerting. Reconcile old unresolved attempts against Knock run/message logs while those logs still exist.
- Alert on workflow errors **and** unexpected skipped/no-message outcomes for workflows that must always create an in-app Notification.
- Define the user-facing offline/error state: retain the last loaded feed, show a retry affordance, and reconcile when connectivity returns.

## 11. Observability

### Facts

- Knock's dashboard provides API logs, workflow-run debugger/logs, message timelines, workflow Activity, and analytics for run, delivery, and engagement (including seen/read/interacted). API logs can be filtered by request ID/status/endpoint, but Knock does not store `/feeds` response bodies. [API logs](https://docs.knock.app/developer-tools/api-logs), [debugging workflows](https://docs.knock.app/send-notifications/debugging-workflows), [analytics](https://docs.knock.app/send-notifications/analytics)
- Message-status changes are Message Events and can be sent through outbound webhooks. Knock retries most non-2xx webhook failures a handful of times over hours, but not specified 3xx/4xx responses. [Message statuses](https://docs.knock.app/send-notifications/message-statuses), [outbound webhooks](https://docs.knock.app/developer-tools/outbound-webhooks/overview)
- Knock can stream workflow/channel/message success and error metrics to Datadog or New Relic; the official New Relic documentation identifies that extension as an Enterprise feature. [Integrations overview](https://docs.knock.app/integrations/overview), [New Relic extension](https://docs.knock.app/integrations/extensions/new-relic)
- The dashboard/log views are limited by the 30/90-day retention described above. [Data retention](https://docs.knock.app/manage-your-account/data-retention)

### Inferences

- Knock's dashboard is suitable for recent diagnosis, not Cadence's durable operational ledger. Feed response-body omission also means client rendering/data issues may require Cadence-side telemetry.
- External metrics extensions may impose a plan trade-off; outbound webhooks can export message lifecycle events but require Cadence to operate a verified, idempotent receiver.

### Recommendations

- Log Cadence Notification Event ID, recipient's internal Cadence ID, workflow key, idempotency key, Knock `workflow_run_id`, request ID, and eventual Knock message ID with sensitive payloads excluded.
- Start with dashboard/run logs plus Cadence metrics for dispatch attempts, failures, latency, and unresolved outbox rows. Add outbound message-event webhooks if durable engagement/audit data is a requirement.
- Alert on sustained trigger failures/429s, unresolved dispatches, workflow-run errors, and a fall in expected message creation. Capture client feed fetch/socket/auth failures in Cadence's frontend telemetry.
- Treat Datadog/New Relic streaming and 90-day Knock logs as commercial-plan decisions, not baseline assumptions.

## Product trade-offs the specification must resolve

| Trade-off | Knock constraint | Required Cadence decision |
|---|---|---|
| Read semantics | Knock distinguishes `seen` from `read`; pre-built UI defaults the badge to unseen. | Use `read`/unread count as recommended, or explicitly redefine the product behavior. |
| Content correction | A generated feed item's content cannot be edited. | Accept immutable Notifications and archive/reissue corrections, including how duplicate-looking items appear. |
| Retention/privacy | Feed items are available indefinitely; archive hides but does not delete. | Choose visible lifetime and true-erasure policy before launch. |
| Real-time guarantee | Socket event has no body and may be throttled. | Promise eventual reconciliation, not lossless/instantaneous socket delivery. |
| Duplicate prevention | Trigger idempotency is limited to identical calls within 24 hours. | Maintain Cadence-owned durable deduplication/outbox state. |
| Security/data ownership | Browser calls Knock directly; default responses can expose all trigger and recipient/actor custom data. | Require signed least-privilege tokens and an explicit data allowlist. |
| Local/offline testing | Official development is cloud-backed; no documented local emulator was found. | Accept mocked unit tests plus development-environment integration tests. |
| Operations cost | Base logs expire after 30 days; 90-day logs and observability streaming depend on Enterprise capabilities. | Decide whether Cadence-owned exports suffice or an Enterprise plan is required. |

## Source boundary

Only first-party Knock sources were used: `docs.knock.app`, `knock.app` pricing where plan context was relevant, and Knock's verified `knocklabs/knock-node` repository. No secondary articles or community answers were used. “No documented local emulator was found” is explicitly an inference from the official development surfaces reviewed, not a vendor guarantee that no such capability exists.
