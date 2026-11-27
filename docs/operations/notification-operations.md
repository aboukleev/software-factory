# Notification operations

Notification telemetry is deliberately content-free. Delivery IDs, Notification Event identities, lifecycle states, normalized outcome codes, timing, and provider-generated opaque IDs are allowed. Never copy discussion text, previews, names, email addresses, tokens, secrets, or raw provider responses into logs, incident notes, or exercise evidence.

## Controls

The singleton `notification_operation_controls` row is the persisted control plane. Change it through `createNotificationOperations().setControls(...)` from an authenticated operator shell or maintenance task; do not edit application configuration or redeploy.

- `creationEnabled`: when false, discussion writes still commit but create no new Notification Event or Delivery.
- `dispatchEnabled`: when false, the dispatcher still records heartbeats but claims no work. Existing work remains durable.
- `feedEnabled`: when false, Feed routes, session discovery, and token issuance are unavailable. Creation and dispatch are unaffected.

Record the reason, operator, timestamp, and before/after state in the incident record. Restore only the control that was paused after its specific risk is resolved.

## Alerts and investigation

Alerts start investigation; they never reissue a Notification automatically.

- `dispatcher_heartbeat_missing`: after two minutes, verify the application process and dispatcher loop, then inspect due work before restarting.
- `oldest_due_over_five_minutes`: pause creation if backlog growth risks the 24-hour window; inspect normalized attempt outcomes and provider health.
- `acceptance_unresolved_over_five_minutes`: inspect the provider workflow run by opaque reference and run reconciliation. Do not requeue ambiguous work.
- `delivery_objective_sustained_miss`: compare first-attempt, accepted, and delivered latency with backlog and provider status over the same sampling window.
- `permanent_configuration_or_authentication_failure`: pause dispatch, correct workflow/authentication configuration, verify with a dedicated test recipient, then use safe requeue rules.
- `unknown_outcome`: reconcile provider evidence. Requeue only after the provider confirms that no Notification was created.
- `confirmed_duplicate`: pause dispatch and Feed presentation, preserve idempotency and provider evidence, and treat the event as a reliability and privacy incident.

## Recovery procedures

### Safe requeue

Use the outcome service's `requeue` operation only for a permanent failure or unresolved outcome less than 24 hours old. An unresolved outcome first requires recorded provider evidence that no Notification exists. Requeue preserves the original Notification Event, payload, recipient, and idempotency key. Never clone a Delivery or invent a new identity.

### Privacy containment

Immediately disable Feed presentation/token issuance and pause creation and dispatch. Preserve content-free correlation identifiers, identify affected recipients through authorized database access, and avoid reproducing protected source data in the incident record. Correct authorization/filtering, perform required provider deletion, verify erasure, and restore controls independently.

### Confirmed duplicate response

Pause dispatch, retain both opaque provider message IDs in the duplicate incident, and determine whether duplication is logical or physical. Do not mark duplicate work successful or automatically retry it. Confirm provider state and remediate recipient-visible duplicates before restoring dispatch.

### Backlog recovery and restoration

Keep creation paused if inflow would prevent recovery. Restore dispatch first with Feed presentation still disabled, sample backlog and latency, and confirm due age is falling without new permanent/unknown outcomes. Restore creation, then Feed/token access, one control at a time. Confirm heartbeat, zero unexpected duplicates, reconciliation progress, and objectives after each step.

## Fault and soak exercise

Use dedicated test recipients and never production discussion content. Start a content-free evidence stream with:

```sh
npm run notifications:soak-report -- --samples=40 --interval-ms=15000 > notification-soak.jsonl
```

Pause dispatch, create dedicated synthetic test activity through the normal application seam, wait longer than one poll interval, then restore dispatch. The JSON-lines report contains only aggregate backlog, heartbeat, normalized outcome counts, alerts, and latency/objective measurements. Verify first attempts within 30 seconds, at least 95% stored within one minute, and at least 99% within five minutes over a meaningful sample; retain the report with the release evidence. Delete the local report after evidence has been transferred to the approved content-free location.
