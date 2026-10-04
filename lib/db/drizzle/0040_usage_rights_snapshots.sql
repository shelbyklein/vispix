ALTER TABLE "project_photos" ADD COLUMN "rights_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "image_generations" ADD COLUMN "rights_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL;