CREATE TABLE `analytics_dataset` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`version` text NOT NULL,
	`summary_json` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_analytics_dataset_owner` ON `analytics_dataset` (`owner_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `analytics_report` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`dataset_id` text NOT NULL,
	`summary_json` text NOT NULL,
	`report_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`dataset_id`) REFERENCES `analytics_dataset`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_analytics_report_owner` ON `analytics_report` (`owner_id`,`created_at`);