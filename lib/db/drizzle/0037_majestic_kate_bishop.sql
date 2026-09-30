-- Usage-rights tag names become unique per organization instead of globally (#113 follow-up).
-- The per-org index is created before the global constraint is dropped, so uniqueness never
-- lapses; it can't fail on existing data because a globally unique name is also unique per org.
CREATE UNIQUE INDEX "attribution_tags_org_name_unique" ON "attribution_tags" USING btree ("organization_id","name");--> statement-breakpoint
ALTER TABLE "attribution_tags" DROP CONSTRAINT "attribution_tags_name_unique";
