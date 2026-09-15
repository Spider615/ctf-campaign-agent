CREATE TABLE `codetable` (
	`field_key` text NOT NULL,
	`value` text NOT NULL,
	`label` text NOT NULL,
	`vintage_year` integer NOT NULL,
	`source_image` text NOT NULL,
	`completeness` text NOT NULL,
	PRIMARY KEY(`field_key`, `value`)
);
--> statement-breakpoint
CREATE TABLE `draft_version` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`brief_json` text NOT NULL,
	`ics_orders_json` text NOT NULL,
	`created_by` text NOT NULL,
	`patch_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_version_session_seq` ON `draft_version` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_version_session_created` ON `draft_version` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `message` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL,
	`produced_version_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_message_session_created` ON `message` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `patch` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`from_version` integer NOT NULL,
	`ops_json` text NOT NULL,
	`source` text NOT NULL,
	`reason` text NOT NULL,
	`model` text,
	`tokens` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_patch_session_created` ON `patch` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`entry_mode` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_session_updated_at` ON `session` (`updated_at`);--> statement-breakpoint
CREATE TABLE `store_constant` (
	`store_code` text NOT NULL,
	`business_category` text NOT NULL,
	`concession_rate` integer NOT NULL,
	`collection_rate` integer NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`store_code`, `business_category`)
);
