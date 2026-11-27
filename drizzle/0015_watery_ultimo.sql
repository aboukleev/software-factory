PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notification_operation_controls` (
	`id` integer PRIMARY KEY NOT NULL,
	`creation_enabled` integer DEFAULT false NOT NULL,
	`dispatch_enabled` integer DEFAULT true NOT NULL,
	`feed_enabled` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_notification_operation_controls`("id", "creation_enabled", "dispatch_enabled", "feed_enabled", "updated_at") SELECT "id", false, "dispatch_enabled", false, CURRENT_TIMESTAMP FROM `notification_operation_controls`;--> statement-breakpoint
DROP TABLE `notification_operation_controls`;--> statement-breakpoint
ALTER TABLE `__new_notification_operation_controls` RENAME TO `notification_operation_controls`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
