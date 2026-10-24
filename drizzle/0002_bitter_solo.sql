CREATE TABLE `conversation_thread` (
	`id` text NOT NULL,
	`owner_id` text NOT NULL,
	`scope` text NOT NULL,
	`thread_json` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `id`)
);
--> statement-breakpoint
CREATE INDEX `idx_conversation_thread_scope` ON `conversation_thread` (`owner_id`,`scope`,`updated_at`);