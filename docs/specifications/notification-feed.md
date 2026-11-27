# Knock-backed Notification Feed specification

Status: approved implementation handoff. Canonical tracker: [#13](https://github.com/aboukleev/software-factory/issues/13). Rollout ticket: [#27](https://github.com/aboukleev/software-factory/issues/27).

This is the single version-controlled normative specification for Cadence's first Notification Feed release. GitHub issues remain decision provenance; when a conflict exists, the explicit reconciliation in this document governs the implemented release.

## Purpose and scope

Cadence gives Students, Instructors, and Platform Admins a durable in-app way to notice and return to relevant Question activity. The Feed is not a task queue, audit log, guaranteed Delivery mechanism, or proof of attention. Only the in-app Channel is included.

A newly committed Student Question notifies the Course's owning Instructor captured at commit time. A newly committed Reply by that Instructor or a Platform Admin notifies the Student who asked the Question. Other Student Replies, non-owning Instructor Replies, staff top-level contributions, edits, deletions, reads, page loads, role or Enrollment changes, retries, rejected writes, and rolled-back writes create no Notification Event. Replies to pre-launch Questions do not qualify. Self-notification retains the Notification Event but creates no Delivery.

Launch applies only to future qualifying commits after the global creation control is enabled. There is no historical backfill, recipient canary, cohort rollout, or Notification for a pre-launch Question.

## Domain and ownership

Use Student, Instructor, Platform Admin, Question, Reply, Notification Event, Notification, Notification Feed, Read Notification, Channel, and Delivery. The database role `admin` means Platform Admin in product language.

Cadence owns Notification Event creation, recipient selection, authorization, durable dispatch, deduplication, enrichment, retries, privacy enforcement, retention actions, controls, and operational evidence. Knock owns recipient-visible Notification storage, authoritative reverse-chronological ordering and cursor pagination, unread counts, and Read Notification state.

One logical Notification is identified by Notification Event, recipient, and Channel. Event identities are `question.created:<sourceCommentId>` and `staff-reply.created:<sourceCommentId>`. Separate comments remain separate occurrences even when their text is identical.

## Transaction, Delivery, and recovery

The source comment, immutable Notification Event, and initial Delivery commit atomically in the existing SQLite database. Conversation writes never wait for Knock. Every attempt reuses the immutable allowlisted payload and idempotency key.

Delivery states distinguish queued, attempting, retry scheduled, accepted, delivered, cancelled, permanently failed, and outcome unknown. `accepted` means the trigger was accepted; `delivered` requires provider evidence that the item was stored. The embedded single-process dispatcher wakes after commits, polls every 15 seconds, claims work with renewable two-minute leases, bounds concurrency, and times out provider requests after 15 seconds.

The first attempt is immediate. Transient failures retry at approximately 1 minute, 5 minutes, 15 minutes, 1 hour, 4 hours, and 12 hours with ±20% jitter. No automatic or manual requeue may create a new occurrence after the original Event reaches 24 hours. Ambiguous work is requeued only after provider evidence confirms no Notification exists. Later work is not blocked by an earlier failure for the same recipient. A confirmed physical duplicate is an incident, not success.

Operational objectives, measured from occurrence over meaningful rolling samples, are first attempt within 30 seconds, 95% stored within one minute, and 99% stored within five minutes. They are not per-recipient guarantees or individual-test assertions.

The architectural rationale is [ADR 0001: embedded durable Notification dispatcher](../adr/0001-embedded-durable-notification-dispatcher.md).

## Provider security and privacy

Knock Users use stable internal Cadence person IDs, never email. Browser tokens are issued only by an authenticated Cadence endpoint, expire within one hour, and carry explicit `user/feed_read` and `user/feed_write` grants. Enhanced security and the checked-in Feed response allowlist are release requirements. Secret and signing keys remain server-side.

Knock receives only the recipient ID, Event kind and occurrence time, stable Course/Lesson/Question/source-comment IDs, and stable event/idempotency identity. It receives no name, email, avatar, actor ID, source content, preview, title, slug, mutable role, authorization state, or raw application object. Logs, telemetry, analytics, errors, and release evidence remain content-free.

Every Feed operation is scoped to the authenticated recipient. Cadence resolves current display context and rechecks authorization for every enrichment and destination. Identifier tampering or unavailable content returns a neutral result without revealing deletion versus lost authorization.

## Content, navigation, and Feed behavior

Question wording is “A Student asked a Question.” Owning-Instructor wording is “Your Instructor replied to your Question.” Platform Admin wording is “A Platform Admin replied to your Question.” Authorized context is `Course title · Lesson title`, with a current-source, plain-text, URL-free, one-line preview of at most 140 characters. The immutable Event time is shown relatively with an exact localized time available.

Activation explicitly marks one item read and navigates to the exact Question or Reply. It never waits for a read mutation. A successful destination scrolls, focuses, and briefly highlights the source. A live Reply below a deleted Question remains reachable. Missing or unauthorized content says “Conversation no longer available”; transient enrichment says “Details temporarily unavailable” and offers retry.

The sidebar bell uses a dot, not a count. An open Feed shows the exact unread count. Desktop has a quick popover and a full Feed route; narrow screens use a full-screen sheet. Opening does not mark read. Mark all read includes unloaded items existing at Knock's processing boundary. There is no mark-unread, recipient archive, dismiss, or delete action.

The Feed preserves Knock ordering, paginates with Load more, never reorders on read, and keeps read items until expiry. New items insert at the top only when the recipient is near the top; otherwise the Feed preserves scroll position and offers New Notifications. Arrivals never open the Feed, steal focus, play sound, or show a toast. Visible cached items remain during transient refresh failure and are labelled out of date; Feed data and tokens are never persisted to browser storage.

WebSocket and person-scoped `BroadcastChannel` events are content-free refresh hints. Reconcile at shell start, Feed open, hint, mutation completion, focus/connectivity return, and every 60 seconds while visible. Account changes disconnect the old client and immediately clear in-memory state.

## Accessibility

Each item is one keyboard-activatable link whose accessible name orders unread state, actor/event wording, Course and Lesson, preview, and exact time. Feed surfaces are named regions; modal surfaces contain focus, close on Escape, and restore focus to the bell. Visible focus, touch targets, polite announcements, reduced-motion and forced-colors behavior, and long/narrow-layout continuity are required. Automated Axe analysis must report no serious or critical violations at 1280×800 and 390×844; manual assistive-technology review is useful but non-blocking.

## Lifecycle reconciliation: accepted deviation

The original #13 text required per-Notification permanent deletion at 90 days and said archive was insufficient. Provider verification established that Knock offers neither per-message permanent deletion nor a configurable 90-day Feed retention mechanism. [ADR 0002](../adr/0002-use-knock-archive-for-notification-expiry.md) therefore records an accepted deviation: at 90 days Cadence archives the provider message for recipient-visible expiry, removes local lifecycle records after confirmed archive, and accepts reversible provider-side residue. Archive must never be represented as permanent deletion.

Whole-User hard deletion remains the verified permanent mechanism for account erasure and must not be used for ordinary item expiry. Failed archive retains local records and raises a content-free privacy incident for retry. This deviation is an explicit known limitation and is not a hidden claim that the original per-item deletion requirement was met.

## Operations and rollout

Content-free telemetry covers Delivery transitions, due/in-flight backlog, oldest due age, attempts/outcomes, accepted/delivered latency, unresolved acceptance, permanent failures, unknown outcomes, cancellations, duplicates, heartbeat, and expired-lease recovery. Alerts cover missing heartbeat, old backlog, unresolved acceptance, sustained objective misses, permanent configuration/authentication failure, unknown outcomes, and duplicates.

Three durable global controls independently govern creation, dispatch claims, and Feed/token presentation without redeployment. Dark deployment defaults creation and Feed presentation disabled while schema, code, workflows, telemetry, alerts, and controls are staged. Production provisioning is a separate release activity. After all gates and a controlled Production smoke pass, the release owner enables creation and Feed presentation globally in one recorded step; dispatch is never used to backfill history.

Pause immediately for cross-recipient exposure, authorization bypass, sensitive-data leakage, duplicate logical Notifications, invalid token/filter configuration, unverified erasure, sustained dispatcher/backlog failure, or widespread Feed/read/navigation failure. Privacy or authorization incidents also disable presentation/token issuance.

Rollback pauses creation and dispatch, and disables presentation when containment requires it. It preserves Notification Events and Delivery records, leaves valid Knock Notifications intact, and uses forward-compatible schema rather than destructive migration reversal. Provider data is permanently deleted only for account erasure or a verified privacy incident; ordinary expiry follows ADR 0002.

## Verification contract

Credential-free gates are typecheck, unit/service tests with real migrations and a fake provider, production build, migration/seed validation, offline workflow validation, Playwright browser coverage, and Axe analysis. The separately invoked Knock Development contract uses disposable recipients and cleans them, and verifies signed grants, enhanced security, filtering, both workflows, Feed creation/read/pagination, real-time hints, idempotency, provider references/outcomes, reversible archive, and whole-User deletion. A controlled content-free soak/fault exercise records objective measurements without flaky percentile assertions.

Production smoke uses dedicated test recipients while automatic creation and presentation remain disabled. It verifies grants, filtering, workflow trigger, Feed storage, read mutation, real-time hint, deep-link authorization, archive, whole-User deletion, and complete test-data cleanup. Production provisioning and actual global enablement are outside implementation ticket #27.

## Provenance

- Source map: [#2](https://github.com/aboukleev/software-factory/issues/2).
- Provider research: [#10](https://github.com/aboukleev/software-factory/issues/10) and the cited [research artifact](https://github.com/aboukleev/software-factory/blob/b4fb63064c209e4af8160f8c04513226d5730478/docs/research/knock-notification-feed-constraints.md).
- Interaction decision: [#5](https://github.com/aboukleev/software-factory/issues/5) and the throwaway [prototype](https://github.com/aboukleev/software-factory/tree/prototype/notification-feed).
- Canonical decisions: [security boundary #6](https://github.com/aboukleev/software-factory/issues/6), [event contract #9](https://github.com/aboukleev/software-factory/issues/9), [content/navigation #3](https://github.com/aboukleev/software-factory/issues/3), [reliability #8](https://github.com/aboukleev/software-factory/issues/8), [lifecycle/read semantics #7](https://github.com/aboukleev/software-factory/issues/7), and [verification/rollout #4](https://github.com/aboukleev/software-factory/issues/4).
- Architecture: [ADR 0001](../adr/0001-embedded-durable-notification-dispatcher.md) and accepted provider-residue deviation [ADR 0002](../adr/0002-use-knock-archive-for-notification-expiry.md).

## Explicit non-goals

Email, push, SMS, Slack, mobile Channels, preferences, muting, quiet hours, per-Course controls, additional Event types, historical backfill, guaranteed Delivery or ordering, attention proof, task/audit semantics, recipient archive/delete/mark-unread, a Platform Admin health UI, recipient canaries, mandatory manual accessibility sign-off, a separate queue service, Production Knock provisioning, and actual global enablement are excluded.
