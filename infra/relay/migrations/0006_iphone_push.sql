CREATE TABLE `push_devices` (
	`session_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`topic` text NOT NULL,
	`environment` text NOT NULL,
	`mode` text NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_device_token` ON `push_devices` (`token`,`topic`,`environment`);--> statement-breakpoint
CREATE INDEX `push_device_user` ON `push_devices` (`user_id`);--> statement-breakpoint
CREATE TABLE `push_mailboxes` (
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	PRIMARY KEY(`session_id`, `email`),
	FOREIGN KEY (`session_id`) REFERENCES `push_devices`(`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`email`) REFERENCES `linked_accounts`(`user_id`,`email`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `push_revocations` (
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`revoked_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `session_id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
