CREATE TABLE `person_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`token` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `person_tokens_name_unique` ON `person_tokens` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `person_tokens_token_unique` ON `person_tokens` (`token`);