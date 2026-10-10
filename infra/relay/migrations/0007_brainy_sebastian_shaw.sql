CREATE TABLE `notification_authorizations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`provider` text NOT NULL,
	`session_id` text NOT NULL,
	`session_created_at` integer NOT NULL,
	`verifier` text NOT NULL,
	`return_to` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `notification_connections` (
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`provider` text NOT NULL,
	`generation` text NOT NULL,
	`credential` text NOT NULL,
	`status` text DEFAULT 'connecting' NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `email`),
	FOREIGN KEY (`user_id`,`email`) REFERENCES `linked_accounts`(`user_id`,`email`) ON UPDATE no action ON DELETE cascade
);
