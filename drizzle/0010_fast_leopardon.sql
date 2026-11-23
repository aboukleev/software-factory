CREATE TABLE `notification_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`notification_event_id` integer NOT NULL,
	`recipient_id` integer NOT NULL,
	`channel` text NOT NULL,
	`workflow_key` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`provider_payload` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`notification_event_id`) REFERENCES `notification_events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_deliveries_event_recipient_channel_unique` ON `notification_deliveries` (`notification_event_id`,`recipient_id`,`channel`);--> statement-breakpoint
CREATE UNIQUE INDEX `notification_deliveries_idempotency_unique` ON `notification_deliveries` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `notification_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`identity` text NOT NULL,
	`kind` text NOT NULL,
	`occurred_at` text NOT NULL,
	`source_comment_id` integer NOT NULL,
	`root_question_id` integer NOT NULL,
	`actor_id` integer NOT NULL,
	`actor_capacity` text NOT NULL,
	`recipient_id` integer NOT NULL,
	`course_id` integer NOT NULL,
	`lesson_id` integer NOT NULL,
	FOREIGN KEY (`source_comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`root_question_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lesson_id`) REFERENCES `lessons`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_events_identity_unique` ON `notification_events` (`identity`);