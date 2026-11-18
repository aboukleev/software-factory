ALTER TABLE `refunds` RENAME TO `refund_requests`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_refund_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_id` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`reason` text NOT NULL,
	`amount_refunded` integer,
	`eligibility_completed_lessons` integer DEFAULT 0 NOT NULL,
	`eligibility_total_lessons` integer DEFAULT 0 NOT NULL,
	`eligibility_watched_seconds` integer DEFAULT 0 NOT NULL,
	`eligibility_redeemed_seats` integer DEFAULT 0 NOT NULL,
	`requested_at` text NOT NULL,
	`resolved_at` text,
	`resolved_by_user_id` integer,
	`resolution_note` text,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resolved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_refund_requests`("id", "purchase_id", "status", "reason", "amount_refunded", "eligibility_completed_lessons", "eligibility_total_lessons", "eligibility_watched_seconds", "eligibility_redeemed_seats", "requested_at", "resolved_at", "resolved_by_user_id", "resolution_note") SELECT "id", "purchase_id", "status", "reason", "amount_refunded", 0, 0, 0, 0, "requested_at", "resolved_at", "resolved_by_user_id", NULL FROM `refund_requests`;--> statement-breakpoint
DROP TABLE `refund_requests`;--> statement-breakpoint
ALTER TABLE `__new_refund_requests` RENAME TO `refund_requests`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `refund_requests_purchase_idx` ON `refund_requests` (`purchase_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refund_requests_one_open_per_purchase_idx` ON `refund_requests` (`purchase_id`) WHERE "refund_requests"."status" = 'open';
