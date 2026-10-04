ALTER TABLE "image_generations" ADD COLUMN "base_storage_key" text;--> statement-breakpoint
ALTER TABLE "image_generations" ADD COLUMN "composition" jsonb;--> statement-breakpoint
ALTER TABLE "image_generations" ADD COLUMN "photo_treatment" text;--> statement-breakpoint
ALTER TABLE "image_generations" ADD COLUMN "format_resolution" jsonb;--> statement-breakpoint
ALTER TABLE "image_generations" ADD COLUMN "provenance" jsonb;--> statement-breakpoint
ALTER TABLE "image_generations" ADD COLUMN "acknowledged_missing" jsonb;