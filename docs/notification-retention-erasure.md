# Notification retention and erasure

Cadence measures the 90-day visible lifetime from immutable Notification Event
occurrence time. Read state, retries, opening the Feed, and later authorization
changes do not move that boundary. Unaccepted work is cancelled when its source
is deleted and is permanently failed before an automatic attempt can begin at
or after the 24-hour replay boundary. The embedded notification runtime runs
the lifecycle pass at startup and hourly thereafter.

## Provider constraint and release decision

At exactly 90 days, Cadence archives the individual Knock message so it expires
from the recipient-visible Feed, then removes the local Notification Event,
Delivery, and dependent operational records. There is no local archive or
per-item tombstone.

**Archive is not permanent deletion.** Knock retains provider-side residue and
can unarchive the message. The release owner has explicitly accepted that
limitation instead of escalating the product decision to Knock. Cadence records
the mechanism as recipient-visible expiry, never as permanent deletion or
successful provider erasure.

If archive fails, Cadence records a content-free privacy incident and retains
the local Event, Delivery, and dependent operational records so the lifecycle
pass can retry. Local cleanup happens only after archive succeeds.

Knock's verified permanent operation is deletion of a whole User, which removes
all messages for that recipient. Cadence uses it for account erasure only. It
must not delete a whole User to expire one Notification because doing so would
destroy unrelated Feed history. Knock also does not offer a custom 90-day Feed
retention policy. This provider residue is an accepted limitation, not a
release blocker.

The explicitly invoked Knock Development contract uses disposable data to
prove both sides of this distinction: an archived message can be unarchived and
returns to the Feed, while deleting the disposable User removes all of that
recipient's messages. Ordinary automated tests never use live credentials.

## Local lifecycle

- Cancelled and permanently failed Delivery records are removed 90 days after
  terminal state.
- Accepted and delivered records are removed after the provider message is
  successfully archived at 90 days. If archive cannot be confirmed, they are
  retained with the privacy incident needed for retry.
- Recipient account erasure hard-deletes the Knock User and removes the local
  recipient Events and Deliveries.
- Actor account erasure clears the local actor identifier but preserves the
  content-free Event and Delivery so the recipient item can still follow normal
  expiry.
- Source deletion after provider acceptance does not retract the Notification;
  enrichment returns the generic unavailable-content behavior until expiry,
  unless a verified privacy incident requires archive containment.
