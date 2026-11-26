# Knock Notification resources

These files are the version-controlled source for Cadence's two in-app-only
Knock workflows. `npm run validate:knock` validates them offline and is part of
the ordinary test command.

## Development environment contract

The live contract is intentionally separate from ordinary tests and Playwright:

```sh
NOTIFICATION_PROVIDER_MODE=knock \
KNOCK_SECRET_API_KEY=... \
KNOCK_PUBLIC_API_KEY=... \
KNOCK_SIGNING_KEY=... \
KNOCK_FEED_CHANNEL_ID=... \
npm run test:knock-contract
```

`KNOCK_SIGNING_KEY` accepts Knock's recommended single-line base64-encoded PEM
format as well as raw PEM and PEM with escaped newlines.

Before running it, push and commit both workflows to the isolated Knock
Development environment, apply `feed-response-filter.json` to that environment's
in-app channel API response filter, and enable enhanced security. The contract
proves enhanced security by rejecting an unsigned public-key request. It then
uses a disposable numeric recipient, verifies both workflows, signed grants,
response filtering, idempotency, provider references, cursor paging, a real-time
hint and Read Notification state. It verifies that archive is reversible and
therefore is not permanent deletion, then permanently deletes the disposable
recipient and verifies that all of that recipient's messages are removed.

Knock does not expose per-message permanent deletion or configurable 90-day
Feed retention. Cadence must not delete a whole Knock User to expire one item.
This is a release blocker for the 90-day erasure criterion; archive remains
available only for immediate incident containment.

Knock processes User hard deletion asynchronously and documents that associated
data cleanup can take up to ten minutes. The live contract waits for that full
window before failing its whole-User deletion assertion.

Fake mode remains the credential-free default outside Production. Production
requires `NOTIFICATION_PROVIDER_MODE=knock`; incomplete configuration throws
instead of falling back.

Authenticated outcome webhooks additionally require `KNOCK_WEBHOOK_SECRET`,
the shared secret configured for the Knock outbound webhook endpoint.
