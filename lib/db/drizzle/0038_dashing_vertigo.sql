CREATE INDEX "photos_storage_key_idx" ON "photos" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "photos_thumbnail_key_idx" ON "photos" USING btree ("thumbnail_key");