# Use an embedded durable SQLite Notification dispatcher

Cadence runs Notification Delivery dispatch inside its single production server and stores queue state beside conversation writes in SQLite. We chose this over a separate queue service because it keeps Question or Reply, Notification Event, and Delivery creation in one atomic transaction without a distributed-commit or outbox handoff.

This decision deliberately depends on the single-process production constraint. Leases and idempotent provider calls cover restarts, but SQLite is not the coordination boundary for multiple application processes. Moving to a horizontally scaled server or dedicated queue will require migrating unfinished Delivery state, preserving immutable identities and idempotency keys, replacing SQLite claim coordination, and running both dispatch paths without double-claiming during cutover.
