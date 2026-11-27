# Use Knock archive for Notification expiry

Cadence archives each Knock message at 90 days to remove it from the recipient-visible Feed, then deletes its local lifecycle records without a tombstone. We accept that archive is reversible and leaves provider-side residue because Knock offers neither per-message permanent deletion nor configurable 90-day Feed retention; archive must never be described as permanent deletion, while whole-User hard deletion remains the mechanism for account erasure.
