CREATE TABLE `notification_delivery_transitions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`delivery_id` integer NOT NULL,
	`notification_event_id` integer NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`outcome_code` text NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`delivery_id`) REFERENCES `notification_deliveries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`notification_event_id`) REFERENCES `notification_events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notification_delivery_transitions_delivery_idx` ON `notification_delivery_transitions` (`delivery_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `notification_dispatcher_heartbeats` (
	`id` integer PRIMARY KEY NOT NULL,
	`observed_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_operation_controls` (
	`id` integer PRIMARY KEY NOT NULL,
	`creation_enabled` integer DEFAULT true NOT NULL,
	`dispatch_enabled` integer DEFAULT true NOT NULL,
	`feed_enabled` integer DEFAULT true NOT NULL,
	`updated_at` text NOT NULL
);
