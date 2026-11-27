CREATE TABLE `notification_delivery_incidents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`delivery_id` integer NOT NULL,
	`provider_event_id` text NOT NULL,
	`kind` text NOT NULL,
	`evidence` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`delivery_id`) REFERENCES `notification_deliveries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_delivery_incidents_provider_event_unique` ON `notification_delivery_incidents` (`provider_event_id`);--> statement-breakpoint
CREATE TABLE `notification_outcome_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`delivery_id` integer NOT NULL,
	`provider_event_id` text NOT NULL,
	`kind` text NOT NULL,
	`provider_message_ids` text,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`delivery_id`) REFERENCES `notification_deliveries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_outcome_events_provider_event_unique` ON `notification_outcome_events` (`provider_event_id`);--> statement-breakpoint
CREATE INDEX `notification_outcome_events_delivery_idx` ON `notification_outcome_events` (`delivery_id`);--> statement-breakpoint
ALTER TABLE `notification_deliveries` ADD `provider_message_id` text;--> statement-breakpoint
ALTER TABLE `notification_deliveries` ADD `outcome_evidence` text;--> statement-breakpoint
ALTER TABLE `notification_deliveries` ADD `outcome_checked_at` text;--> statement-breakpoint
ALTER TABLE `notification_deliveries` ADD `outcome_next_check_at` text;--> statement-breakpoint
CREATE INDEX `notification_deliveries_outcome_due_idx` ON `notification_deliveries` (`status`,`outcome_next_check_at`);