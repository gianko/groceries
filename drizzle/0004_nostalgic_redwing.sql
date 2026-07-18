CREATE TABLE `expiry_verdicts` (
	`lot_id` integer PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`lot_id`) REFERENCES `stock_lots`(`id`) ON UPDATE no action ON DELETE no action
);
