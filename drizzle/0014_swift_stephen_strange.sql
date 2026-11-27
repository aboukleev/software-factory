PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notification_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`identity` text NOT NULL,
	`kind` text NOT NULL,
	`occurred_at` text NOT NULL,
	`source_comment_id` integer NOT NULL,
	`root_question_id` integer NOT NULL,
	`actor_id` integer,
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
INSERT INTO `__new_notification_events`("id", "identity", "kind", "occurred_at", "source_comment_id", "root_question_id", "actor_id", "actor_capacity", "recipient_id", "course_id", "lesson_id") SELECT "id", "identity", "kind", "occurred_at", "source_comment_id", "root_question_id", "actor_id", "actor_capacity", "recipient_id", "course_id", "lesson_id" FROM `notification_events`;--> statement-breakpoint
DROP TABLE `notification_events`;--> statement-breakpoint
ALTER TABLE `__new_notification_events` RENAME TO `notification_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `notification_events_identity_unique` ON `notification_events` (`identity`);