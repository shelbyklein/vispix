ALTER TABLE "campaigns" ADD COLUMN "brief_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "last_generate_request_id" text;