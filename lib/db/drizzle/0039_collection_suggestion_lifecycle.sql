CREATE TYPE "public"."photo_suggestion_resolution" AS ENUM('review', 'manual');--> statement-breakpoint
CREATE TYPE "public"."photo_suggestion_source" AS ENUM('model', 'heuristic');--> statement-breakpoint
ALTER TABLE "photo_collection_suggestions" ADD COLUMN "source" "photo_suggestion_source" DEFAULT 'model' NOT NULL;--> statement-breakpoint
ALTER TABLE "photo_collection_suggestions" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "photo_collection_suggestions" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "photo_collection_suggestions" ADD COLUMN "analysis_version" text;--> statement-breakpoint
ALTER TABLE "photo_collection_suggestions" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "photo_collection_suggestions" ADD COLUMN "resolution" "photo_suggestion_resolution";--> statement-breakpoint
ALTER TABLE "photo_collection_suggestions" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "photo_collection_suggestions" ADD COLUMN "decided_by_id" integer;--> statement-breakpoint
ALTER TABLE "photo_new_collection_suggestions" ADD COLUMN "source" "photo_suggestion_source" DEFAULT 'model' NOT NULL;--> statement-breakpoint
ALTER TABLE "photo_new_collection_suggestions" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "photo_new_collection_suggestions" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "photo_new_collection_suggestions" ADD COLUMN "analysis_version" text;--> statement-breakpoint
ALTER TABLE "photo_new_collection_suggestions" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "photo_new_collection_suggestions" ADD COLUMN "resolution" "photo_suggestion_resolution";--> statement-breakpoint
ALTER TABLE "photo_new_collection_suggestions" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "photo_new_collection_suggestions" ADD COLUMN "decided_by_id" integer;--> statement-breakpoint
ALTER TABLE "photo_collection_suggestions" ADD CONSTRAINT "photo_collection_suggestions_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_new_collection_suggestions" ADD CONSTRAINT "photo_new_collection_suggestions_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Existing-data mapping (docs/COLLECTION_SUGGESTIONS.md). Pure status/provenance
-- updates: no membership, negative-example or suggestion row is deleted.
-- 1. Legacy accepted/dismissed rows were all decided in the suggestion UI.
UPDATE "photo_collection_suggestions" SET "resolution" = 'review' WHERE "status" IN ('accepted', 'dismissed') AND "resolution" IS NULL;--> statement-breakpoint
UPDATE "photo_new_collection_suggestions" SET "resolution" = 'review' WHERE "status" IN ('accepted', 'dismissed') AND "resolution" IS NULL;--> statement-breakpoint
-- 2. A pending suggestion for a collection the photo is already in was
--    resolved by a human add: mark it accepted/manual (membership untouched).
UPDATE "photo_collection_suggestions" s SET "status" = 'accepted', "resolution" = 'manual' WHERE s."status" = 'pending' AND EXISTS (SELECT 1 FROM "photo_collections" pc WHERE pc."collection_id" = s."collection_id" AND pc."photo_id" = s."photo_id");
