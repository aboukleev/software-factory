# Notification retention and erasure

Cadence measures the 90-day visible lifetime from immutable Notification Event
occurrence time. Read state, retries, opening the Feed, and later authorization
changes do not move that boundary. Unaccepted work is cancelled when its source
is deleted and is permanently failed before an automatic attempt can begin at
or after the 24-hour replay boundary. The embedded notification runtime runs
the lifecycle pass at startup and hourly thereafter.

## Provider constraint and release decision

Knock Feed archive is reversible containment. **Archive is not deletion** and
must never be recorded as successful retention erasure. The provider adapter
therefore rejects per-message permanent deletion explicitly. A failed or
unsupported erasure creates a content-free privacy incident with
`releaseBlocked: true`, while retaining the local Delivery needed to retry and
audit the failure.

Knock's verified permanent operation is deletion of a whole User, which removes
all messages for that recipient. Cadence uses it for account erasure only. It
must not delete a whole User to expire one Notification because doing so would
destroy unrelated Feed history. Knock also does not offer a custom 90-day Feed
retention policy. Consequently, global Notification release remains blocked
until a provider-supported per-message permanent-erasure mechanism or an
equivalent enforceable 90-day retention control exists.

The explicitly invoked Knock Development contract uses disposable data to
prove both sides of this distinction: an archived message can be unarchived and
returns to the Feed, while deleting the disposable User removes all of that
recipient's messages. Ordinary automated tests never use live credentials.

## Local lifecycle

- Cancelled and permanently failed Delivery records are removed 90 days after
  terminal state.
- Delivered records are retained until provider erasure succeeds; deleting them
  while the provider item survives would destroy the retry and incident trail.
- Recipient account erasure hard-deletes the Knock User and removes the local
  recipient Events and Deliveries.
- Actor account erasure clears the local actor identifier but preserves the
  content-free Event and Delivery so the recipient item can still follow normal
  expiry.
- Source deletion after provider acceptance does not retract the Notification;
  enrichment returns the generic unavailable-content behavior until expiry,
  unless a verified privacy incident requires archive containment.
