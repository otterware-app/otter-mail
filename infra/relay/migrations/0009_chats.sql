CREATE TABLE `chats` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`title` text NOT NULL,
	`provider` text NOT NULL,
	`session_id` text,
	`session_owned` integer DEFAULT false NOT NULL,
	`last_response_id` text,
	`device` text,
	`tabs` text NOT NULL,
	`turns` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
