CREATE TABLE `__new_notification_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`notification_event_id` integer NOT NULL,
	`recipient_id` integer NOT NULL,
	`channel` text NOT NULL,
	`workflow_key` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`provider_payload` text NOT NULL,
	`status` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`first_attempt_at` text,
	`last_attempt_at` text,
	`accepted_at` text,
	`delivered_at` text,
	`terminal_at` text,
	`error_category` text,
	`provider_request_id` text,
	`provider_workflow_run_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`notification_event_id`) REFERENCES `notification_events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `__new_notification_deliveries` (`id`, `notification_event_id`, `recipient_id`, `channel`, `workflow_key`, `idempotency_key`, `provider_payload`, `status`, `attempt_count`, `next_attempt_at`, `created_at`)
SELECT `id`, `notification_event_id`, `recipient_id`, `channel`, `workflow_key`, `idempotency_key`, `provider_payload`, `status`, 0, `created_at`, `created_at` FROM `notification_deliveries`;--> statement-breakpoint
DROP TABLE `notification_deliveries`;--> statement-breakpoint
ALTER TABLE `__new_notification_deliveries` RENAME TO `notification_deliveries`;--> statement-breakpoint
CREATE UNIQUE INDEX `notification_deliveries_event_recipient_channel_unique` ON `notification_deliveries` (`notification_event_id`,`recipient_id`,`channel`);--> statement-breakpoint
CREATE UNIQUE INDEX `notification_deliveries_idempotency_unique` ON `notification_deliveries` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_due_idx` ON `notification_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_lease_idx` ON `notification_deliveries` (`status`,`lease_expires_at`);
