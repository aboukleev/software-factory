# Use an embedded durable SQLite Notification dispatcher

Cadence runs Notification Delivery dispatch inside its single production server and stores queue state beside conversation writes in SQLite, rather than operating a separate queue service. This keeps Question or Reply, Notification Event, and Delivery creation in one atomic transaction while leases and idempotent provider calls supply crash recovery; it deliberately depends on the single-process deployment constraint, and moving to multiple server processes will require revisiting claim coordination and the queue storage migration.
