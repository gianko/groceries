CREATE TABLE `pendings` (
	`message_id` integer PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `prefs` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`household_size` integer,
	`blurb` text
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`is_staple` integer DEFAULT false NOT NULL,
	`auto_relist` integer DEFAULT false NOT NULL,
	`shelf_life_days` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_name_unique` ON `products` (`name`);--> statement-breakpoint
CREATE TABLE `raw_name_map` (
	`raw_name` text PRIMARY KEY NOT NULL,
	`product_id` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `shopping_list_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`product_id` integer,
	`free_text` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `stock_lots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`quantity` real NOT NULL,
	`unit` text,
	`price` real,
	`purchased_at` text NOT NULL,
	`est_expiry` text,
	`status` text DEFAULT 'in_stock' NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
